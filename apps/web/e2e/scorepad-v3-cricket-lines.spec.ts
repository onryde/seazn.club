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
  // Task A — the seven fields and the person picker that had NO `labelKey`
  // and were therefore captioned by `deriveFieldPathLabel(path)`: derived
  // ENGLISH, rendered in all four locales, and hardcoded into this file as
  // "Batting out"/"Bowling legal balls"/… exactly the drift the helper above
  // exists to stop. They are dictionary keys now, so they are read like the
  // rest.
  innings: playerLineLabel("innings"),
  battingOut: playerLineLabel("battingOut"),
  battingRuns: playerLineLabel("battingRuns"),
  battingBalls: playerLineLabel("battingBalls"),
  bowlingLegalBalls: playerLineLabel("bowlingLegalBalls"),
  bowlingRuns: playerLineLabel("bowlingRuns"),
  bowlingWickets: playerLineLabel("bowlingWickets"),
  person: playerLineLabel("person"),
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
// A SECOND, DEEPER DEFECT USED TO BLOCK THE SUBMISSION ITSELF (found by
// running this test for real for the first time — memory rule "the brief is
// a hypothesis": Task 18's own assumption that fixing the mount would let
// this pass outright did not hold), FIXED HERE (Task 20). `cricket.player
// .line`'s legacy seven fields (`batting.runs`/`.balls`,
// `bowling.legalBalls`/`.runs`/`.wickets`) carried NO `optional: true`
// (cricket.ts's `playerLineAction`, unchanged by Task 17/18 — only the six
// NEW fields got that flag), so `checkActionValidity` (view-model.ts)
// refused Confirm until ALL FIVE were filled, and every real submission
// therefore carried BOTH a `batting` AND a `bowling` sub-object — never
// just one. `applyPlayerLine` (cricket.ts:~1776) then required
// `payload.person` to be a member of the BATTING side's order (for the
// `batting` half) **and** the OPPOSING side's bowling order (for the
// `bowling` half) in the SAME payload — impossible for any real two-team
// fixture, since `state.orders.home`/`.away` are built from disjoint
// rosters (`orderFromLineup`, cricket.ts:3329). Verified first-hand at the
// time, not inferred: a 422 was captured from the trace on fixture
// f35e48b3-693b-4709-8052-ede29e9e3547 — `"V3 Line Batter … is not in the
// bowling lineup for innings 1"`.
//
// Task 20's own investigation found `CricketPlayerLine`'s zod schema
// (cricket.ts:332-369) and `applyPlayerLine` (cricket.ts:1806, 1838)
// ALREADY accepted either aspect alone — `batting`/`bowling` are each
// `.optional()`, with a `.refine()` requiring only "at least one", and the
// two order-membership checks already run independently
// (`if (payload.batting !== undefined)` / `if (payload.bowling !==
// undefined)`). So NO schema or reducer change was needed. The fix is
// `PadField.group` (sport/module.ts): every `batting.*`/`bowling.*` field
// on `playerLineAction` now carries `group: "batting"`/`"bowling"`, and
// `checkActionValidity`/`buildActionPayload` (view-model.ts) treat a group
// with zero touched fields as entirely omitted — not required, and never
// leaking a stray value (e.g. a toggle's own `initialActionValues` default)
// into the built payload — while still refusing Confirm when NEITHER
// aspect is touched at all. This test now RUNS FOR REAL: a batting-only
// line, a bowling-only line, and the legacy single-aspect shape, each
// posted through the pad's actual UI and read back off the ledger.
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

/**
 * Every `send()` in pad-host.tsx (including `ActionFormList`'s own
 * `onSubmit`) goes through `heldSubmit` — a HOLD_MS (12s default,
 * `HOLD_MS_DEFAULT` in scorepad/queue.ts) soft-commit queue.
 *
 * Found by driving THIS action for real, for the first time (the "brief is
 * a hypothesis" rule again): unlike a ball tap, `cricket.player.line` has NO
 * manual "Send now" control to flush early. `pad-host.tsx`'s
 * `resolveDockSpec` calls the cricket skin's `buildDock(eventType, …)`,
 * which opens with `if (!BALL_EVENT_TYPES.has(eventType)) return null` —
 * `BALL_EVENT_TYPES` is only `{"cricket.ball", "cricket.superover.ball"}`
 * (skins/cricket.tsx:153). A `null` dock spec makes `dockController` return
 * `null` too (`detail-dock.tsx:158`), and `DetailDock` itself then renders
 * `null` (`detail-dock.tsx:413`) — an empty `<div data-role="v3-dock">`
 * with no title, no chips, and no dismiss/"Send now" button at all. This is
 * a pre-existing, orthogonal characteristic of the dock/skin system (every
 * generic More-sheet action shares it, not just this one) — out of this
 * task's scope to change, and the scorepad/its skins are on the programme's
 * "do not touch" list. So this spec simply WAITS OUT the natural HOLD_MS
 * window instead of flushing early: every `expect.poll` below gives the
 * drain comfortably more than 12s of margin (25s), and the three
 * submissions are strictly sequential (each poll resolves before the next
 * line's form is even opened), so there is never more than one held item
 * in flight at a time. */

async function playerLineEvents(request: APIRequestContext, fixtureId: string) {
  return (await ledger(request, fixtureId)).filter((e) => e.type === "cricket.player.line");
}

test(
  "cricket v3: the More sheet's Scorecard line accepts a single aspect (batting-only, bowling-only), " +
    "and the legacy single-aspect shape stays byte-identical to the documented shape (Task 20)",
  async ({ page }) => {
    // Task 19 (owner ruling 17) fixed the mount gate — `shouldMountPad`
    // (fixture-console.tsx) keeps the pad mounted in its post phase once
    // decided, proven live in this exact test (the pad reaches "post" and
    // "More" surfaces "Scorecard line"). Task 20 fixed the second, deeper
    // defect the mount fix's own live run exposed — see the file header for
    // the full chain. No `test.fixme` — this spec RUNS.

    // THREE held dispatches (one per player-line submission), each one
    // waited OUT rather than flushed early — see `playerLineEvents`'s own
    // preceding doc comment for why "Send now" does not exist for this
    // event type — plus fixture setup and two innings-summary posts.
    test.setTimeout(180_000);

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
    // A THIRD person (a spare home roster slot), never given a line by the
    // first two submissions below — `applyPlayerLine`'s own dupe check
    // refuses a second line for the SAME person+aspect in one innings, so
    // the legacy-shape line (line 3) needs a person of its own.
    const home2Name = `V3 Line Home2 ${TAG}`;
    const batterId = fx.personIds[batterName]!;
    const bowlerId = fx.personIds[bowlerName]!;
    const home2Id = fx.personIds[home2Name]!;

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

    // --- Line 1: BATTING-ONLY, every batting field touched, bowling never
    // touched at all (Task 20's headline scenario). -----------------------
    await pad(page).getByLabel(PLAYER_LINE_LABEL.innings, { exact: true }).fill("1");
    await pad(page).getByLabel(PLAYER_LINE_LABEL.battingOut, { exact: true }).check();
    await pad(page).getByLabel(PLAYER_LINE_LABEL.battingRuns, { exact: true }).fill("42");
    await pad(page).getByLabel(PLAYER_LINE_LABEL.battingBalls, { exact: true }).fill("30");
    await pad(page).getByLabel(PLAYER_LINE_LABEL.fours, { exact: true }).fill("5");
    await pad(page).getByLabel(PLAYER_LINE_LABEL.sixes, { exact: true }).fill("2");
    // Deliberately NOT filled: the three bowling fields — before Task 20
    // these had to be zero-filled just to satisfy Confirm; now the bowling
    // GROUP stays untouched and is omitted from the built payload entirely
    // (view-model.ts's `groupsTouched`).

    // Task B — the bowler row is GATED on the dismissal kind, and on the
    // kind being one the engine credits a bowler for. Nothing has been
    // picked yet, so it is not on the screen at all: assert that in the
    // browser, since a node-environment unit test cannot see a rendered
    // page and this is the surface the rule "never offer what the engine
    // will refuse" is actually about.
    await expect(
      pad(page).getByRole("group", { name: PLAYER_LINE_LABEL.dismissalBowler, exact: true }),
    ).toHaveCount(0);

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

    // Person: still scoped by `data-attribution-path` rather than by its
    // caption. Task A gave this item a real `labelKey` (it used to render
    // the composed "Scorecard line — Person", derived English in every
    // locale), but the chips inside the row are person NAMES, so the row is
    // addressed by path and the button by name — the caption itself is
    // asserted in action-form.test.ts.
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
    // No "Send now" for this event type (see the doc above) — the poll
    // itself waits out the natural HOLD_MS drain, 25s margin over 12s.
    await expect
      .poll(async () => (await playerLineEvents(page.request, fx.fixtureId)).length, { timeout: 25_000 })
      .toBe(1);

    const battingOnlyLine = (await playerLineEvents(page.request, fx.fixtureId))[0]!;
    // deep-equal, not toMatchObject — no extra keys, every tapped value
    // lands exactly where it was tapped, and NO `bowling` key at all.
    expect(battingOnlyLine.payload).toEqual({
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
    });
    expect(Object.prototype.hasOwnProperty.call(battingOnlyLine.payload, "bowling")).toBe(false);

    // --- Line 2: BOWLING-ONLY, mirroring Line 1 — batting never touched at
    // all, including its dismissed toggle (view-model.ts's `groupsTouched`
    // excludes toggles from "touched" precisely so this leftover default
    // never leaks a half-formed `batting` object into the payload). The
    // bowler ("V3 Line Bowler") is in the AWAY roster, the bowling side for
    // innings 1 — `applyPlayerLine` checks the bowling order independently
    // of the batting order it never touches for this line. `wickets: 1`
    // (not 2) — `applyPlayerLine`'s coarse-mode sum-consistency check bounds
    // it against innings 1's own recorded total of 1 wicket ("150/1"); a
    // higher figure 422s with "player line disagrees with the innings
    // totals", found by driving this line for real (verified directly
    // against the server, not inferred). Confirm on line 1 collapses the
    // row back (ActionFormList's own `resetAction`); the "More" sheet
    // itself stays open, so the same collapsed "Scorecard line" row is
    // tapped again with fresh values. -------------------------------------
    await pad(page).getByRole("button", { name: "Scorecard line", exact: true }).click();
    await pad(page).getByLabel(PLAYER_LINE_LABEL.innings, { exact: true }).fill("1");
    await pad(page).getByLabel(PLAYER_LINE_LABEL.bowlingLegalBalls, { exact: true }).fill("12");
    await pad(page).getByLabel(PLAYER_LINE_LABEL.bowlingRuns, { exact: true }).fill("20");
    await pad(page).getByLabel(PLAYER_LINE_LABEL.bowlingWickets, { exact: true }).fill("1");
    await pad(page).getByLabel(PLAYER_LINE_LABEL.maidens, { exact: true }).fill("1");
    await pad(page).getByLabel(PLAYER_LINE_LABEL.wides, { exact: true }).fill("2");
    await pad(page).getByLabel(PLAYER_LINE_LABEL.noBalls, { exact: true }).fill("0");
    await pad(page)
      .locator('[data-attribution-path="person"]')
      .getByRole("button", { name: bowlerName, exact: true })
      .click();

    await pad(page).getByRole("button", { name: "Confirm", exact: true }).click();
    await expect
      .poll(async () => (await playerLineEvents(page.request, fx.fixtureId)).length, { timeout: 25_000 })
      .toBe(2);

    const bowlingOnlyLine = (await playerLineEvents(page.request, fx.fixtureId))[1]!;
    expect(bowlingOnlyLine.payload).toEqual({
      innings: 1,
      person: bowlerId,
      bowling: { legalBalls: 12, runs: 20, wickets: 1, maidens: 1, wides: 2, noBalls: 0 },
    });
    expect(Object.prototype.hasOwnProperty.call(bowlingOnlyLine.payload, "batting")).toBe(false);

    // --- Line 3: the legacy single-aspect shape — only the ORIGINAL three
    // batting fields (out/runs/balls), none of Task 17's six band-2
    // enrichment fields, and bowling untouched. This is the documented
    // shape a pre-ruling-12 scorer's batting-only line has always produced
    // (byte-identical): before Task 20 the pad could never actually reach
    // it (bowling's three legacy fields had to be zero-filled too); now it
    // can. A fresh person (home2) since `applyPlayerLine` refuses a second
    // line for the SAME person+aspect in one innings. ----------------------
    await pad(page).getByRole("button", { name: "Scorecard line", exact: true }).click();
    await pad(page).getByLabel(PLAYER_LINE_LABEL.innings, { exact: true }).fill("1");
    await pad(page).getByLabel(PLAYER_LINE_LABEL.battingOut, { exact: true }).check();
    await pad(page).getByLabel(PLAYER_LINE_LABEL.battingRuns, { exact: true }).fill("10");
    await pad(page).getByLabel(PLAYER_LINE_LABEL.battingBalls, { exact: true }).fill("8");
    await pad(page)
      .locator('[data-attribution-path="person"]')
      .getByRole("button", { name: home2Name, exact: true })
      .click();

    await pad(page).getByRole("button", { name: "Confirm", exact: true }).click();
    await expect
      .poll(async () => (await playerLineEvents(page.request, fx.fixtureId)).length, { timeout: 25_000 })
      .toBe(3);

    const legacyShapeLine = (await playerLineEvents(page.request, fx.fixtureId))[2]!;
    // The documented single-aspect legacy shape: `{ innings, person,
    // batting: { out, runs, balls } }` — no fours/sixes/dismissal key, and
    // no `bowling` key at all (updated from Task 18's own documented shape,
    // which required both aspects — see the file header for why that was
    // never actually reachable through the product).
    expect(legacyShapeLine.payload).toEqual({
      innings: 1,
      person: home2Id,
      batting: { out: true, runs: 10, balls: 8 },
    });
    expect(Object.prototype.hasOwnProperty.call(legacyShapeLine.payload, "bowling")).toBe(false);
  },
);
