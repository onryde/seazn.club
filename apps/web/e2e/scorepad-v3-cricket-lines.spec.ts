import { test, expect, type Page, type APIRequestContext } from "@playwright/test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { apiJson, fixturePath, seedRosteredFixture, TAG } from "./helpers";

// Review round 2 (task-18-rereview-ea888772b..74963d93b.md) — round 1's
// `labelKey` additions (cricket.ts's `playerLineAction`) changed several of
// this action's captions away from `deriveFieldPathLabel`'s fallback
// ("Batting fours" -> "Fours", etc.), and this file had two hardcoded
// selectors that assumed the OLD fallback text. Read as a file, not
// `import … from "…json"` — Playwright's loader rejects a bare JSON import
// without an import attribute (same reasoning `division-delete.spec.ts`'s
// own header gives for the identical pattern).
const uiEn = JSON.parse(
  readFileSync(fileURLToPath(new URL("../src/dictionaries/en/ui.json", import.meta.url)), "utf8"),
) as Record<string, string>;

/** The eight new `pad.cricket.action.playerLine.field.*` keys owner ruling
 *  12's fix round 1 registered (cricket.ts + scoring-vocab.ts's
 *  `PAD_LABEL_KEYS` + all four `ui.json` dictionaries). Read from the SAME
 *  dictionary the form renders, not retyped — a future caption change (a
 *  key rename, a reworded label) moves this test with it instead of
 *  silently drifting back out of sync, which is exactly what happened to
 *  the two hardcoded selectors this fix round replaces. Throws loudly at
 *  collection time if a key ever goes missing, rather than a selector
 *  quietly timing out mid-test with no clue why. */
function playerLineLabel(key: string): string {
  const full = `pad.cricket.action.playerLine.field.${key}`;
  const value = uiEn[full];
  if (value === undefined) throw new Error(`scorepad-v3-cricket-lines.spec.ts: no ui.json entry for "${full}"`);
  return value;
}
const PLAYER_LINE_LABEL = {
  fours: playerLineLabel("fours"),
  sixes: playerLineLabel("sixes"),
  dismissalKind: playerLineLabel("dismissalKind"),
  maidens: playerLineLabel("maidens"),
  wides: playerLineLabel("wides"),
  noBalls: playerLineLabel("noBalls"),
  dismissalBowler: playerLineLabel("dismissalBowler"),
  dismissalFielder: playerLineLabel("dismissalFielder"),
} as const;

// Task 18 — owner ruling 12 (2026-09-05, the ONLY deliberate scorepad touch
// of the spectator match-centre programme). Task 17 (engine) made
// `cricket.player.line` carry six optional band-2 fields on top of the seven
// it always had (`batting.fours`/`.sixes`/`.dismissal{kind,bowler,fielder}`,
// `bowling.maidens`/`.wides`/`.noBalls`); this wave wired the pad's generic
// "More" sheet to collect them. This is the FIRST e2e to drive a
// `cricket.player.line` through the pad UI (previously only reachable via
// direct API posts in scorecard.test.ts's engine-level fixtures).
//
// SCOPE SPLIT (controller ruling, task 18 dispatch): the brief's own e2e
// description also asserts the PUBLIC match centre reads the posted line
// back (`mc-bat-<personId>`). That surface is not wired yet (runs after
// Task 15) — this spec stops at the LEDGER, reading the fixture's own event
// list back through the same `/api/v1/fixtures/:id/events` endpoint the
// existing cricket walkthroughs already use. The public-page assertion is
// owed to Task 15's own e2e coverage; see this task's report.
//
// MOUNT GATE FIXED (Task 19, owner ruling 17, 2026-09-06 "Decision 1 -
// fix") — this spec was `test.fixme`'d at Task 18 (review round 1,
// task-18-review.md, confirmed independently by two sessions —
// implementer's report + reviewer's own re-derivation): `cricket.player.line`'s
// only panel is `phase: "post"` (`packages/engine/src/sports/cricket/
// cricket.ts:3090-3096`), and the cricket skin's `resolvePhase`
// (`apps/web/src/components/v2/scorepad/v3/skins/cricket.tsx:1163-1167`)
// maps PadPhase `"post"` 1:1 from the engine's `state.phase === "done" |
// "final"` — the ONLY way in. But BOTH real consumers of the pad used to
// unmount it entirely the instant a fixture became decided
// (`apps/web/src/components/v2/fixture-console.tsx` and
// `device-score-pad.tsx`, `decided = live.outcome !== null || ...`), and
// every terminal `state.phase` sets a non-null outcome in the same return
// (`cricket.ts`'s `decideWin`/tie/draw/no-result branches) — the instant
// PadPhase resolved to `"post"` was the instant the pad disappeared, no
// window. This predated Task 18 —
// `apps/web/e2e/scorepad-v3-football.spec.ts:1236-1239` already documented
// the identical gap for football (which has no post-phase panel at all, so
// its own decided-fixture behaviour is UNCHANGED by this fix — see that
// spec's own decided-shootout test).
//
// `shouldMountPad` (exported from `fixture-console.tsx`, shared by
// `device-score-pad.tsx`) fixes exactly this: a decided fixture now keeps
// the pad mounted iff the resolved module's `padSpec(cfg)` declares at
// least one post-phase panel — cricket does (the Scorecard panel below),
// most sports don't and are unaffected. Builder-level proof:
// `apps/web/src/components/v2/__tests__/fixture-console-post-phase.test.tsx`.
// PROVEN LIVE, in this exact test, on a fresh Task 19 build: the pad DOES
// reach "post" phase on a decided fixture and the "More" sheet DOES surface
// "Scorecard line" — the owner-ruling-17 mount defect is gone.
//
// A SECOND, DEEPER, UNRELATED DEFECT BLOCKS THE SUBMISSION ITSELF (found by
// running this test for real for the first time — memory rule "the brief is
// a hypothesis": Task 18's own assumption that fixing the mount would let
// this pass outright does not hold). `cricket.player.line`'s legacy seven
// fields (`batting.runs`/`.balls`, `bowling.legalBalls`/`.runs`/`.wickets`)
// carry NO `optional: true` (cricket.ts's `playerLineAction`, unchanged by
// Task 17/18 — only the six NEW fields got that flag), so
// `checkActionValidity` (view-model.ts:232) refuses Confirm until ALL FIVE
// are filled, and every real submission therefore carries BOTH a `batting`
// AND a `bowling` sub-object — never just one. `applyPlayerLine`
// (cricket.ts:~1776) then requires `payload.person` to be a member of the
// BATTING side's order (for the `batting` half) **and** the OPPOSING side's
// bowling order (for the `bowling` half) in the SAME payload — impossible
// for any real two-team fixture, since `state.orders.home`/`.away` are
// built from disjoint rosters (`orderFromLineup`, cricket.ts:3329). Verified
// first-hand, not inferred: this test's own POST (captured from the trace,
// fixture f35e48b3-693b-4709-8052-ede29e9e3547) —
//   request  {"payload":{"innings":1,"batting":{"out":true,"runs":42,...},
//             "bowling":{"legalBalls":0,"runs":0,"wickets":0},
//             "person":"5fe3b568-…" /* the HOME batter */}}
//   response 422 {"code":"INVALID_EVENT","message":"V3 Line Batter … is not
//             in the bowling lineup for innings 1"}
// The same structural conflict blocks a bowling-credit line the other way
// (a bowler is never in the batting side's order either). Net: NEITHER of
// this test's two submissions — nor any real scorer's — can ever succeed
// through the pad's generic form as it stands today, independent of the
// mount fix above. This predates Task 17/18/19 entirely (the legacy seven
// fields are original to the action) and is out of Task 19's scope —
// `cricket.ts`/`action-form.tsx`/`view-model.ts` are not on this task's
// file list and remain on the programme's "do not touch" list. Flagged for
// the owner/controller per this program's standing rule ("bench product
// gaps → TELL the owner"): Task 15's own planned e2e (reading the enriched
// line back on the PUBLIC page) cannot succeed until this is resolved
// either — there is still no way to get a `cricket.player.line` onto a
// fixture's ledger through the product. `test.fixme` restored below with
// this new reason (not deleted, not weakened — every assertion is
// byte-identical to Task 18's round 1) so this known-red spec does not
// break the `e2e-parallel` CI job on the next push (task-18-review.md's own
// Critical #1 finding, still the applicable rule).
//
// Deliberately NOT serial: this spec seeds its own fixture, so there is no
// shared-fixture race to serialise for (matches scorepad-v3-cricket.spec.ts's
// own header reasoning).
test.describe.configure({ mode: "parallel" });

function pad(page: Page) {
  return page.locator('[data-testid="score-pad"]');
}

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

/** Post a real ledger event directly (reads `last_seq` fresh each call, the
 *  same pattern scorepad-v3-cricket.spec.ts's own `postEvent` uses) — used
 *  here only to get the fixture into "post" phase fast: `core.start` plus
 *  two FORCE-CLOSED (`partial` omitted) `cricket.innings.summary` totals,
 *  which is what `cricket.ts`'s `decideAfterClose` needs to decide a result
 *  and set `state.phase = "done"` for a default `inningsPerSide: 1` cfg —
 *  the ONE thing that puts the pad's own `resolvePhase` (v3/skins/cricket.tsx)
 *  into "post", which is where `cricket.player.line`'s own padSpec panel
 *  lives (phase: "post", the "Scorecard" panel). Nothing here is under test;
 *  the real pad interaction starts after the `page.goto` below. */
async function postEvent(
  request: APIRequestContext,
  fixtureId: string,
  type: string,
  payload: Record<string, unknown>,
): Promise<void> {
  const state = await apiJson<{ last_seq: number }>(request, `/api/v1/fixtures/${fixtureId}/state`);
  if (state.status !== 200 || !state.data) {
    throw new Error(`postEvent(${type}): GET state -> ${state.status} ${JSON.stringify(state.error)}`);
  }
  const res = await apiJson(request, `/api/v1/fixtures/${fixtureId}/events`, "POST", {
    expected_seq: state.data.last_seq,
    type,
    payload,
  });
  if (res.status >= 300) {
    throw new Error(`postEvent(${type}) -> ${res.status} ${JSON.stringify(res.error)}`);
  }
}

/** Every `send()` in pad-host.tsx (including `ActionFormList`'s own
 *  `onSubmit`) goes through `heldSubmit` — a HOLD_MS (12s default) soft-
 *  commit queue, exactly like every ball tap in scorepad-v3-cricket.spec.ts.
 *  Flushing through the dock's own "Send now" (`pad.dock.dismiss`) rather
 *  than waiting out the window keeps this spec's budget sane for TWO
 *  separate player-line submissions. */
async function sendHeldNow(page: Page): Promise<void> {
  await pad(page)
    .locator('[data-role="v3-dock"]')
    .getByRole("button", { name: "Send now", exact: true })
    .click();
}

async function playerLineEvents(request: APIRequestContext, fixtureId: string) {
  return (await ledger(request, fixtureId)).filter((e) => e.type === "cricket.player.line");
}

test(
  "cricket v3: the More sheet's Scorecard line collects 4s/6s/how-out/bowler credit, and a " +
    "legacy-only line stays byte-identical to the pre-ruling-12 7-field payload",
  async ({ page }) => {
    // Task 19 (owner ruling 17) — see the file header for the full chain.
    // Short version: the ORIGINAL fixme (Task 18) is gone — `shouldMountPad`
    // (fixture-console.tsx) now keeps the pad mounted in its post phase once
    // decided, proven live in this exact test (the pad reaches "post" and
    // "More" surfaces "Scorecard line"). A SECOND, unrelated, pre-existing
    // defect still blocks the submission itself (legacy 7-field group always
    // sends both a batting AND bowling aspect; the engine then requires the
    // same person to be in BOTH sides' lineups, which no real fixture can
    // satisfy — verified via the 422 in the file header). Re-fixme'd with
    // this new reason, not deleted or weakened — remove once that defect is
    // fixed (owner/controller decision owed, out of Task 19's scope).
    test.fixme(
      true,
      "cricket.player.line still cannot be submitted: the mount defect (owner ruling 17) is FIXED " +
        "(the pad reaches post phase and the More sheet surfaces \"Scorecard line\" — proven before this " +
        "guard was re-added), but the legacy 7-field group has no `optional: true` on either aspect " +
        "(cricket.ts's playerLineAction), so every real Confirm sends BOTH `batting` and `bowling`, and " +
        "applyPlayerLine (cricket.ts) then requires the SAME person to be in both the batting side's AND " +
        "the opposing bowling side's order — impossible for any real fixture (disjoint rosters). 422 " +
        "INVALID_EVENT \"… is not in the bowling lineup for innings 1\", captured verbatim in the file " +
        "header. Pre-existing, unrelated to Task 19, out of scope (cricket.ts/action-form.tsx/view-model.ts " +
        "are not on this task's file list) — flagged for the owner/controller, blocks Task 15 too.",
    );

    // Two held dispatches (one per player-line submission), each flushed via
    // "Send now" rather than waited out — see sendHeldNow's own doc — plus
    // fixture setup and two innings-summary posts.
    test.setTimeout(90_000);

    // THREE players a side, not one: `allOutWickets` (cricket.ts) is
    // `max(1, min(cfg.playersPerSide, order.length) - 1)` — a one-player
    // roster caps "all out" at 1 wicket, which the innings-1 total below
    // (deliberately > 1, to exercise a real number rather than the
    // degenerate floor) would then exceed and 422. Three gives an all-out
    // ceiling of 2, comfortably above the single wicket each summary below
    // records.
    const fx = await seedRosteredFixture(page.request, {
      label: `V3 Cricket Player Line ${TAG}`,
      sportKey: "cricket",
      variantKey: "t20",
      home: [
        { fullName: `V3 Line Batter ${TAG}` },
        { fullName: `V3 Line Home2 ${TAG}` },
        { fullName: `V3 Line Home3 ${TAG}` },
      ],
      away: [
        { fullName: `V3 Line Bowler ${TAG}` },
        { fullName: `V3 Line Away2 ${TAG}` },
        { fullName: `V3 Line Away3 ${TAG}` },
      ],
    });
    const batterName = `V3 Line Batter ${TAG}`;
    const bowlerName = `V3 Line Bowler ${TAG}`;
    const batterId = fx.personIds[batterName]!;
    const bowlerId = fx.personIds[bowlerName]!;

    await postEvent(page.request, fx.fixtureId, "core.start", {});
    // Innings 1 — home bats first (no toss posted, cricket.ts's default
    // `battingFirst: "home"`). Force-closed regardless of wickets/balls
    // (`partial` omitted -> `applySummary` calls `closeOpenInnings`
    // unconditionally) — this is a coarse SUMMARY line, not a delivery, so
    // no ball-by-ball fold is needed to reach a decided match.
    await postEvent(page.request, fx.fixtureId, "cricket.innings.summary", {
      runs: 150,
      wickets: 1,
      legalBalls: 120,
    });
    // Innings 2 — away chases target 151 (home's 150 + 1) and reaches it:
    // `decideAfterClose` (cricket.ts) decides a win once BOTH innings have
    // closed, setting `state.phase = "done"`.
    await postEvent(page.request, fx.fixtureId, "cricket.innings.summary", {
      runs: 151,
      wickets: 1,
      legalBalls: 100,
    });

    await page.goto(await fixturePath(page.request, fx.fixtureId));
    await expect(pad(page)).toBeVisible({ timeout: 20_000 });

    // "post" phase is now live — the skin's "More" tile (phases: live/post)
    // surfaces `cricket.player.line`, the ONLY action in the "post" phase's
    // "Scorecard" panel (cricket.ts's `padSpec`).
    await pad(page).getByRole("button", { name: "More", exact: true }).click();
    await pad(page).getByRole("button", { name: "Scorecard line", exact: true }).click();

    // --- Line 1: every new field touched. ---------------------------------
    await pad(page).getByLabel("Innings", { exact: true }).fill("1");
    await pad(page).getByLabel("Batting out", { exact: true }).check();
    await pad(page).getByLabel("Batting runs", { exact: true }).fill("42");
    await pad(page).getByLabel("Batting balls", { exact: true }).fill("30");
    await pad(page).getByLabel(PLAYER_LINE_LABEL.fours, { exact: true }).fill("5");
    await pad(page).getByLabel(PLAYER_LINE_LABEL.sixes, { exact: true }).fill("2");
    // The original seven fields cover BOTH a batting and a bowling aspect on
    // one action (`checkActionValidity` requires every declared, non-
    // optional field) — this line only bats, so its bowling aspect is
    // recorded as zeroes, exactly as a scorer filing a batting-only line
    // always had to before this task.
    await pad(page).getByLabel("Bowling legal balls", { exact: true }).fill("0");
    await pad(page).getByLabel("Bowling runs", { exact: true }).fill("0");
    await pad(page).getByLabel("Bowling wickets", { exact: true }).fill("0");

    // The dismissal-kind chip row (owner ruling 12/S18 — PadFieldEnum.chips).
    // Scoped by `data-field-path`, not by PLAYER_LINE_LABEL.dismissalKind's
    // own caption text — a field-chip row (renderField's "chips" branch,
    // action-form.tsx) carries no `role`/`aria-label` grouping the way an
    // ATTRIBUTION row does (below), only the bare `data-field-path`
    // attribute, so there is no accessible name here for a caption change
    // to invalidate. Selected by its VALUE ("Bowled"), never its caption,
    // either way.
    await pad(page)
      .locator('[data-field-path="batting.dismissal.kind"]')
      .getByRole("button", { name: "Bowled", exact: true })
      .click();

    // Person: scoped by `data-attribution-path`, not caption text — this
    // item has no `labelKey` (Task 17/18's own precedent of leaving the
    // main person slot uncaptioned, `attribution-picker.tsx`), so
    // `attributionItemCaption` derives it AND composes it with the
    // action's own label ("Scorecard line — Person"), a two-part string
    // this fix round did not touch and has no dictionary entry of its own
    // to read back.
    await pad(page)
      .locator('[data-attribution-path="person"]')
      .getByRole("button", { name: batterName, exact: true })
      .click();
    // Bowler credit: `renderAttributionRow` gives an item WITH a `labelKey`
    // (fix round 1's addition here) a bare `role="group"` `aria-label`
    // equal to that label, no action-name prefix
    // (`attributionItemCaption` returns via `padLabel(item.labelKey...)`
    // before ever composing with `actionLabel`) — so this one IS selected
    // from the same dictionary value the form renders.
    await pad(page)
      .getByRole("group", { name: PLAYER_LINE_LABEL.dismissalBowler, exact: true })
      .getByRole("button", { name: bowlerName, exact: true })
      .click();

    await pad(page).getByRole("button", { name: "Confirm", exact: true }).click();
    await sendHeldNow(page);

    await expect
      .poll(async () => (await playerLineEvents(page.request, fx.fixtureId)).length, { timeout: 20_000 })
      .toBe(1);

    const enrichedLine = (await playerLineEvents(page.request, fx.fixtureId))[0]!;
    // deep-equal, not toMatchObject — no extra keys, and every tapped value
    // lands exactly where it was tapped.
    expect(enrichedLine.payload).toEqual({
      innings: 1,
      person: batterId,
      batting: {
        out: true,
        runs: 42,
        balls: 30,
        fours: 5,
        sixes: 2,
        dismissal: { kind: "bowled", bowler: bowlerId },
      },
      bowling: { legalBalls: 0, runs: 0, wickets: 0 },
    });

    // --- Line 2: negative-with-positive pair — touch NOTHING new. ---------
    // Confirm on line 1 collapses the row back (ActionFormList's own
    // `resetAction`); the "More" sheet itself stays open, so the same
    // collapsed "Scorecard line" row is tapped again with fresh values.
    await pad(page).getByRole("button", { name: "Scorecard line", exact: true }).click();
    await pad(page).getByLabel("Innings", { exact: true }).fill("1");
    await pad(page).getByLabel("Batting out", { exact: true }).check();
    await pad(page).getByLabel("Batting runs", { exact: true }).fill("10");
    await pad(page).getByLabel("Batting balls", { exact: true }).fill("8");
    await pad(page).getByLabel("Bowling legal balls", { exact: true }).fill("6");
    await pad(page).getByLabel("Bowling runs", { exact: true }).fill("4");
    await pad(page).getByLabel("Bowling wickets", { exact: true }).fill("1");
    await pad(page)
      .locator('[data-attribution-path="person"]')
      .getByRole("button", { name: batterName, exact: true })
      .click();

    await pad(page).getByRole("button", { name: "Confirm", exact: true }).click();
    await sendHeldNow(page);

    await expect
      .poll(async () => (await playerLineEvents(page.request, fx.fixtureId)).length, { timeout: 20_000 })
      .toBe(2);

    const legacyLine = (await playerLineEvents(page.request, fx.fixtureId))[1]!;
    // The exact legacy 7-field shape (pre-ruling-12) — no fours/sixes/
    // dismissal/maidens/wides/noBalls key anywhere, proving the six new
    // optional fields never widen the payload when a scorer never touches
    // them.
    expect(legacyLine.payload).toEqual({
      innings: 1,
      person: batterId,
      batting: { out: true, runs: 10, balls: 8 },
      bowling: { legalBalls: 6, runs: 4, wickets: 1 },
    });
  },
);
