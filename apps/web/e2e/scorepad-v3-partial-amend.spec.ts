import { test, expect, type Page, type APIRequestContext } from "@playwright/test";
import { apiJson, seedRosteredFixture, TAG, type RosteredFixture } from "./helpers";
import { HOLD_MS } from "../src/components/v2/scorepad/queue";
import { DOUBLE_SUBMIT_WINDOW_MS } from "../src/components/v2/scorepad/use-pad-pipeline";
import {
  HIT_TARGET_FLOOR_PX,
  consentedAnonymousState,
  floorViolationLines,
  hitTargetFloorReport,
  measureHitTargets,
  measureOverflowPx,
} from "./scorepad-a11y-kit";

// R8 / register item #675 — AMENDING a row the hold window cut short.
//
// WHY THIS CANNOT BE PROVED ANYWHERE ELSE. `partial-amend.test.ts` (vitest)
// proves the amendment's SHAPE against the real engine and the real skin: that
// a `core.void` plus a re-append carries the attribution into the derived
// state, does not double-count, and clears the badge. It cannot prove the two
// things this file exists for, because apps/web vitest is `environment: "node"`
// with no DOM:
//
//  1. THAT THE BADGE IS REACHABLE AT ALL. R7 shipped this exact badge as a
//     label past a green suite. A `partialBadge()` that returns "amend" and a
//     button a thumb can actually land on are different claims, and only a
//     browser settles the second — AGENTS.md failure class 2 in as many words.
//  2. THAT THE HOLD REALLY DRAINS UNANSWERED AND THE ROW REALLY COMES BACK
//     PARTIAL. The whole defect starts with a timer nothing in a node
//     environment runs.
//
// WHY THE DEVICE LINK AND NOT THE CONSOLE, which is not a detail. The pad
// mounts its OWN `<ActivityPanel>` only where nothing else does — `/score/
// [token]`, the handed device a courtside scorer holds. The organiser console
// passes `hideActivity` and renders the panel one level out (`fixture-console.
// tsx`), so it wires no `onAmend` and its badge stays the R7 label. Found by
// running the first draft of this file against the console and watching the
// badge come back a `<span>`: the amend does not reach that surface, and
// closing it needs the same upward handoff R7-46 built for `isPartial`
// (`onPartialResolver`). Recorded in the task report as owed, not papered over
// here — this file proves the surface the feature actually ships on.
//
// THE TIMING IS DERIVED, NEVER TYPED. Two constants govern this file and both
// are imported: `HOLD_MS` (env-tunable — `NEXT_PUBLIC_SCOREPAD_HOLD_MS` — and
// BAKED INTO THE BROWSER BUNDLE at build time, so this process's value is only
// right when the server under test was built with the same env) and
// `DOUBLE_SUBMIT_WINDOW_MS`, which silently swallows a second identical tap
// (#699: it presents as "Expected: 2, Received: 1", never as an error).
//
// A blown budget here will report itself as a DATA defect — the runner prints
// whichever `expect.poll` was in flight above the timeout line (AGENTS.md,
// failure class 20). `test.setTimeout` is therefore DERIVED from the hold too,
// so moving `HOLD_MS` moves the budget with it.
test.describe.configure({ mode: "parallel" });

/** Two full hold windows (the drain, then the reopened dock) plus room for the
 *  seeding, the page load and the ledger polls. Expressed against the constant
 *  so a doubled `HOLD_MS` cannot turn this file into a phantom data defect. */
const BUDGET_MS = Math.max(180_000, 90_000 + 4 * HOLD_MS);

/** Long enough for the hold to release ON ITS OWN — never a dismiss, which is
 *  an immediate flush and would prove the opposite of what this file needs. */
const DRAIN_MS = HOLD_MS + 5_000;

/** The device surface renders no `data-testid="score-pad"` wrapper to scope to
 *  — `scorepad-offline.spec.ts` records the same fact — so the chassis root is
 *  the scope, and it is what the 44px gate is measured over. */
function pad(page: Page) {
  return page.locator('[data-role="pad-v3"]');
}

function v3Dock(page: Page) {
  return pad(page).locator('[data-role="v3-dock"]');
}

function activity(page: Page) {
  return pad(page).locator('[data-role="v3-activity"]');
}

/** The badge, in EITHER state — the label R7 shipped and the R8 control carry
 *  the same `data-role` deliberately, so this locator cannot silently start
 *  matching only the state a test hopes for. `data-amendable` tells them apart
 *  and is asserted explicitly rather than selected on. */
function partialBadge(page: Page) {
  return activity(page).locator('[data-role="v3-activity-partial"]');
}

/** Home first, matching scorebug.tsx's own render order. A tappable half has no
 *  fixed accessible name — it is the players' own names — so it is addressed
 *  positionally, exactly as the sibling badminton spec does. */
function half(page: Page, side: "home" | "away") {
  return pad(page)
    .locator('[data-role="v3-scorebug"]')
    .getByRole("button")
    .nth(side === "home" ? 0 : 1);
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

const ralliesOf = async (request: APIRequestContext, fixtureId: string) =>
  (await ledger(request, fixtureId)).filter((e) => e.type === "badminton.rally");

interface Pair {
  fx: RosteredFixture;
  secret: string;
  homeFirst: string;
  homeSecond: string;
}

/** A doubles pair on a handed device — the only badminton shape that opens a
 *  scorer dock at all (a singles tap is stamped complete at tap time, so it can
 *  never be partial). `pairOrder` runs the OTHER WAY from the array order, the
 *  same trap the sibling badminton spec sets. */
async function seedPair(request: APIRequestContext, label: string): Promise<Pair> {
  const homeFirst = `V3 Amend ${label} HomeA ${TAG}`;
  const homeSecond = `V3 Amend ${label} HomeB ${TAG}`;
  const fx = await seedRosteredFixture(request, {
    label: `V3 Amend ${label} ${TAG}`,
    sportKey: "badminton",
    variantKey: "bwf",
    entrantKind: "pair",
    home: [
      { fullName: homeSecond, pairOrder: 2 },
      { fullName: homeFirst, pairOrder: 1 },
    ],
    away: [
      { fullName: `V3 Amend ${label} AwayB ${TAG}`, pairOrder: 2 },
      { fullName: `V3 Amend ${label} AwayA ${TAG}`, pairOrder: 1 },
    ],
    emitCoreStart: true,
  });
  const minted = await apiJson<{ secret: string }>(
    request,
    `/api/v1/fixtures/${fx.fixtureId}/device-links`,
    "POST",
    { label: `V3 Amend ${label} ${TAG}` },
  );
  expect(minted.status, `mint device link: ${JSON.stringify(minted.error)}`).toBe(201);
  return { fx, secret: minted.data!.secret, homeFirst, homeSecond };
}

/** The token is the ONLY credential on this surface, so the context must start
 *  with no storage state — a bare `browser.newContext()` inherits the authed
 *  one. Same reasoning `scorepad-offline.spec.ts` records. */
async function openDeviceLink(page: Page, secret: string): Promise<void> {
  await page.goto(`/score/${secret}`);
  const accept = page.getByRole("button", { name: "Accept", exact: true });
  if ((await accept.count()) > 0) await accept.click();
  await expect(pad(page), "the v3 pad must render on the device link").toBeVisible({ timeout: 20_000 });
}

/**
 * The scorebug's POINTS — everything above the context strip.
 *
 * Split from the strip deliberately, and measured rather than assumed. While an
 * amendment is open the client's own ledger briefly holds the original rally AND
 * its pending replacement, so `setBasedServeContext` — a walk over that ledger —
 * honestly REFUSES for the width of the hold window and the "Serving … service
 * court" line drops out, returning the moment the amendment settles. The points
 * do not move at all, and the points are the claim: the round-1 defect was a
 * scored point visibly disappearing. Asserting the whole scorebug string would
 * pin that cosmetic transient as if it were the score.
 */
async function points(page: Page): Promise<string> {
  const text = (await pad(page).locator('[data-role="v3-scorebug"]').innerText()).replace(/\s+/g, " ");
  const strip = text.indexOf("Games");
  return (strip === -1 ? text : text.slice(0, strip)).trim();
}

/** The serve line — present only when the reader can actually name a server. */
const serveLine = (page: Page) => pad(page).locator('[data-role="v3-scorebug"]');

/** Tap a rally and let its dock EXPIRE unanswered — the defect's own starting
 *  state, and the one thing no unit test can produce. */
async function rallyWithDrainedDock(page: Page, side: "home" | "away" = "home"): Promise<void> {
  await half(page, side).click();
  await expect(v3Dock(page), "a pair's rally must open the scorer dock").toBeVisible({ timeout: 20_000 });
  // Answer NOTHING. The dock closes itself when the hold releases.
  await expect(v3Dock(page), "the hold must drain on its own, unanswered").not.toBeVisible({ timeout: DRAIN_MS });
  await page.waitForTimeout(DOUBLE_SUBMIT_WINDOW_MS + 60);
}

// ---------------------------------------------------------------------------
// The round trip, at 320 — the width the ruling was composed for
// ---------------------------------------------------------------------------

test("badminton v3 device link at 320: a drained dock leaves a tappable Partial badge that amends the rally", async ({
  browser,
  request,
}) => {
  test.setTimeout(BUDGET_MS);
  const { fx, secret, homeFirst, homeSecond } = await seedPair(request, "320");
  const ctx = await browser.newContext({
    storageState: await consentedAnonymousState(),
    viewport: { width: 320, height: 720 },
  });
  try {
    const page = await ctx.newPage();
    // 320 FIRST. The scorer is holding a phone at a venue, and the activity row
    // is the tightest space in the pad — it already carries #seq, a caption, a
    // provenance line and Void.
    await openDeviceLink(page, secret);
    // Assert the SEED, not a downstream effect racing something else's own
    // dismissal — see task-2-report.md, Step 7: `expectNoCookieBanner` here
    // raced this file's own `openDeviceLink`'s reactive Accept-click (and,
    // under load, the SSR-visible pad winning against the hydration-gated
    // banner), so it passed in both the seeded and unseeded states. The
    // consent keys are deterministic context state — read them directly.
    const { CONSENT_KEY, CONSENT_VERSION_KEY, COOKIE_POLICY_VERSION } = await import("../src/lib/consent");
    const seeded = await page.evaluate(
      ([k, v]) => ({ choice: localStorage.getItem(k), version: localStorage.getItem(v) }),
      [CONSENT_KEY, CONSENT_VERSION_KEY],
    );
    expect(
      seeded,
      "the anonymous context did not carry seeded consent, so the banner will mount and race this spec",
    ).toEqual({ choice: "rejected", version: COOKIE_POLICY_VERSION });
    await rallyWithDrainedDock(page);

    // The defect: the rally is on the ledger carrying `wonBy` and nothing else.
    await expect.poll(async () => (await ralliesOf(request, fx.fixtureId)).length, { timeout: 60_000 }).toBe(1);
    const settled = (await ralliesOf(request, fx.fixtureId))[0]!;
    expect(settled.payload.wonBy).toBe(fx.homeEntrantId);
    expect(settled.payload.scorer, "the hold drained unanswered, so no scorer was recorded").toBeUndefined();

    // R8 — the badge is a CONTROL, not the label R7 shipped.
    const badge = partialBadge(page);
    await expect(badge, "a drained dock must leave the row labelled partial").toBeVisible({ timeout: 20_000 });
    await expect(badge, "the badge must be the affordance, not a second row action").toHaveAttribute(
      "data-amendable",
      "true",
    );
    expect(await badge.evaluate((n) => n.tagName), "it must be a real button, not a styled span").toBe("BUTTON");
    await expect(badge, "an interactive badge needs an accessible name that says what the tap DOES").toHaveAttribute(
      "aria-label",
      /Tap to add it now/,
    );

    // ONE control gained, not two: Void is still the row's only other action.
    await expect(
      activity(page).locator('[data-role="v3-activity-row"]').first().getByRole("button"),
      "the row may carry exactly the amend badge and Void — a 320px row cannot afford a third",
    ).toHaveCount(2);

    // The 44px floor, through the repo's OWN measurement (`boundingBox`, which
    // the kit's header names as the right primitive for this gate) over every
    // operable target in the pad — never a bespoke re-derivation from a class.
    const report = hitTargetFloorReport(await measureHitTargets(pad(page)), HIT_TARGET_FLOOR_PX);
    expect(report.operable.length, "the floor gate must have measured something").toBeGreaterThan(0);
    expect(floorViolationLines(report), "every operable target in the pad must clear 44px at 320").toEqual([]);

    // …and the new control must not have widened the page.
    expect(await measureOverflowPx(page), "no horizontal page scroll at 320").toBe(0);

    // The score the amendment must never disturb, read BEFORE it starts.
    const settledScore = await points(page);
    await expect(serveLine(page), "one rally to Home, and the serve context that follows from it").toContainText(
      "Serving",
    );

    // THE AMENDMENT. Tapping the badge reopens THAT event's own detail dock.
    await badge.click();
    const dock = v3Dock(page);
    await expect(dock, "tapping Partial must reopen the rally's own scorer dock").toBeVisible({ timeout: 20_000 });
    await expect(dock).toContainText("Which player won it?");
    // Both partners offered, and the LOSING pair never is — the reopened dock is
    // the production one, built by the skin from the re-appended payload, not a
    // second dock written for amendments.
    await expect(dock.getByRole("button", { name: homeFirst, exact: true })).toBeVisible();
    await expect(dock.getByRole("button", { name: homeSecond, exact: true })).toBeVisible();
    // The chips wrap rather than overflow at 320 — the dock is a chip row.
    expect(await measureOverflowPx(page), "the reopened dock must wrap, not overflow, at 320").toBe(0);

    // THE SCORE MUST NOT MOVE WHILE THE AMENDMENT IS OPEN, and this pins the
    // submit ORDER in `handleAmend` (pad-host.tsx). Enqueue the void first and
    // it acks while the replacement is still held: the server's fold — original
    // gone, replacement not yet sent — wins through `serverOverride` and the
    // scorebug read 0—0 for the whole reopened window before snapping back.
    // Measured in a browser, invisible to every node test, and the exact "the
    // point I am fixing just vanished" moment the ruling exists to prevent.
    // Compared against the string read BEFORE the amendment rather than a
    // literal, so it cannot rot into pinning a bug.
    expect(await points(page), "the score must not dip while the reopened dock is waiting for an answer").toBe(
      settledScore,
    );

    // The SECOND partner deliberately: picking the first would also be satisfied
    // by an implementation that always stamped `pairOrder: 1`.
    await dock.getByRole("button", { name: homeSecond, exact: true }).click();
    await dock.getByRole("button", { name: "Send now", exact: true }).click();

    // THE ASSERTION THIS FILE EXISTS FOR. Append-only: the ledger now carries
    // the original rally UNCHANGED, a `core.void` naming it, and a SECOND rally
    // that carries the scorer. Never an edit in place.
    // Polled on BOTH counts together, never on the rally count alone. Since the
    // fix-round-1 change the void is submitted from the replacement's release
    // callback, so it enters the queue a beat AFTER the replacement has already
    // acked — a single read taken the moment the rally count reaches 2 catches
    // the ledger mid-amendment and reports "0 voids", which reads as a missing
    // write rather than as a read that arrived early. This is the terminal
    // state, so wait for the terminal state.
    await expect
      .poll(
        async () => {
          const rows = await ledger(request, fx.fixtureId);
          return {
            rallies: rows.filter((e) => e.type === "badminton.rally").length,
            voids: rows.filter((e) => e.type === "core.void").length,
          };
        },
        { timeout: 60_000 },
      )
      .toEqual({ rallies: 2, voids: 1 });
    const all = await ledger(request, fx.fixtureId);
    const rallies = all.filter((e) => e.type === "badminton.rally");
    const original = rallies.find((r) => r.id === settled.id);
    expect(original, "the original event must still be in the ledger").toBeDefined();
    expect(original!.payload, "the original must NEVER be rewritten in place").toEqual(settled.payload);

    const voids = all.filter((e) => e.type === "core.void");
    expect(voids.length, "exactly one void, naming the original").toBe(1);
    expect(voids[0]!.seq, "the void lands AFTER the replacement, never in front of it").toBeGreaterThan(
      Math.max(...rallies.map((r) => r.seq)),
    );

    const replacement = rallies.find((r) => r.id !== settled.id)!;
    expect(replacement.payload.wonBy, "the correction keeps the side that won").toBe(fx.homeEntrantId);
    expect(
      replacement.payload.scorer,
      "the amended detail must reach the SUBMITTED follow-up, not just a local copy",
    ).toBe(fx.personIds[homeSecond]!);
    expect(replacement.seq, "append-only: the correction lands AFTER the original").toBeGreaterThan(settled.seq);

    // …and the badge is gone: the superseded row is voided, and the row that
    // replaced it is complete. `isPartialDockAnswer` re-runs against the payload.
    await expect(partialBadge(page), "a row that has been completed must no longer read Partial").toHaveCount(0, {
      timeout: 20_000,
    });

    // …and the score is exactly what it was: a correction that adds a name must
    // not move a single point. Proved AFTER A RELOAD too, which throws away
    // every optimistic envelope and replays the ledger the server actually
    // holds — the one reading that can see an append-only correction folding
    // wrong.
    await page.reload();
    await expect(pad(page), "the pad must come back after a reload").toBeVisible({ timeout: 20_000 });
    await expect.poll(async () => points(page), { timeout: 30_000 }).toBe(settledScore);
    // The serve context comes back too — it refuses only WHILE an amendment is
    // in flight, and a lingering refusal would mean the correction folded into a
    // ledger the reader cannot make sense of.
    await expect(serveLine(page), "the serve context must survive the correction").toContainText("Serving", {
      timeout: 20_000,
    });
    await expect(
      partialBadge(page),
      "and the badge stays gone on a clean replay, not just in the optimistic fold",
    ).toHaveCount(0, { timeout: 20_000 });
  } finally {
    await ctx.close();
  }
});

// ---------------------------------------------------------------------------
// THE CRITICAL from fix round 1, driven the way a scorer hits it
// ---------------------------------------------------------------------------

test("badminton v3 device link: taking back an amendment mid-hold leaves the original event intact", async ({
  browser,
  request,
}) => {
  test.setTimeout(BUDGET_MS);
  const { fx, secret } = await seedPair(request, "Cancel");
  const ctx = await browser.newContext({
    storageState: await consentedAnonymousState(),
    viewport: { width: 390, height: 844 },
  });
  try {
    const page = await ctx.newPage();
    await openDeviceLink(page, secret);
    await rallyWithDrainedDock(page, "home");
    await expect.poll(async () => (await ralliesOf(request, fx.fixtureId)).length, { timeout: 60_000 }).toBe(1);
    const settled = (await ralliesOf(request, fx.fixtureId))[0]!;
    const settledScore = await points(page);

    // Open the amendment, then change your mind — which is exactly what someone
    // does after tapping Partial by mistake, and the pad offers the control for
    // it: take-back is ALWAYS available on a held tap by design.
    await partialBadge(page).click();
    await expect(v3Dock(page), "the amendment must be open before we cancel it").toBeVisible({ timeout: 20_000 });
    await pad(page).getByRole("button", { name: "Take back", exact: true }).click();
    await expect(v3Dock(page), "the reopened dock must close on take-back").not.toBeVisible({ timeout: 20_000 });

    // ROUND 1 SHIPPED THE OPPOSITE OF THIS. The void was enqueued as a sibling
    // of the held replacement, so take-back dropped the replacement and left the
    // void to drain ALONE — the original struck through with nothing in its
    // place and the score a point down, the pad deleting the very event the
    // scorer opened the amend to repair. Settled for real: nothing may arrive.
    await page.waitForTimeout(DOUBLE_SUBMIT_WINDOW_MS + 2_000);
    const all = await ledger(request, fx.fixtureId);
    expect(
      all.filter((e) => e.type === "core.void"),
      "a cancelled amendment must write NO void — the original event was never replaced",
    ).toEqual([]);
    const rallies = all.filter((e) => e.type === "badminton.rally");
    expect(rallies.length, "and no duplicate rally either").toBe(1);
    expect(rallies[0]!.id, "the original event is untouched").toBe(settled.id);
    expect(rallies[0]!.payload, "…payload and all").toEqual(settled.payload);

    // On screen: the score never moved, and the row is offering its repair again.
    expect(await points(page), "the score must be exactly where it was").toBe(settledScore);
    // The serve context is the sharpest signal a stranded void leaves behind: a
    // `core.void` left in the durable queue folds out the original on the client,
    // and `setBasedServeContext` then refuses — permanently, and across a reload,
    // because the queue is IndexedDB. That is exactly how the round-1 defect
    // presented when this test first ran against it.
    await expect(serveLine(page), "a cancelled amendment must leave NOTHING behind").toContainText("Serving", {
      timeout: 20_000,
    });
    await expect(
      partialBadge(page),
      "the row is still incomplete, so the amendment is still on offer",
    ).toHaveAttribute("data-amendable", "true", { timeout: 20_000 });
  } finally {
    await ctx.close();
  }
});

// ---------------------------------------------------------------------------
// KNOWN LIMITATION, pinned so it is a decision rather than an accident
// ---------------------------------------------------------------------------

test("badminton v3 device link: after a RELOAD the scorer can no longer amend their own partial row", async ({
  browser,
  request,
}) => {
  test.setTimeout(BUDGET_MS);
  const { fx, secret } = await seedPair(request, "Reload");
  const ctx = await browser.newContext({
    storageState: await consentedAnonymousState(),
    viewport: { width: 390, height: 844 },
  });
  try {
    const page = await ctx.newPage();
    await openDeviceLink(page, secret);
    await rallyWithDrainedDock(page, "home");
    await expect.poll(async () => (await ralliesOf(request, fx.fixtureId)).length, { timeout: 60_000 }).toBe(1);
    await expect(partialBadge(page), "amendable before the reload").toHaveAttribute("data-amendable", "true", {
      timeout: 20_000,
    });

    // THE LIMITATION. `canAmendRow` requires `ownedByMe`, which on a device link
    // means membership of `pipeline.ownEventIds` — and that set is populated
    // only by THIS mount's own submissions. An event arriving through
    // `initialEvents` is never in it ("honestly unknown, never a guess", the
    // pipeline's own words), so a reload demotes the scorer's own partial row to
    // the plain label and the repair path is gone.
    //
    // Inherited from Void, which has always had the same rule — but it bites
    // harder here, because amend IS the repair. Not fixed in this wave: the real
    // fix is persisting `ownEventIds`, which is a pipeline change well beyond
    // this task. Pinned rather than left incidental, so the day it changes this
    // test says so out loud instead of quietly going green.
    await page.reload();
    await expect(pad(page), "the pad must come back after a reload").toBeVisible({ timeout: 20_000 });
    const badge = partialBadge(page);
    await expect(badge, "the row is still labelled partial — R7's half survives").toBeVisible({ timeout: 20_000 });
    await expect(
      badge,
      "KNOWN: ownEventIds does not survive a reload, so the amend is withdrawn — see this test's own note",
    ).not.toHaveAttribute("data-amendable", "true");
    expect(await badge.evaluate((n) => n.tagName), "and it degrades to the label, never a dead button").toBe("SPAN");
  } finally {
    await ctx.close();
  }
});

// ---------------------------------------------------------------------------
// The engine's own limit, on screen
// ---------------------------------------------------------------------------

test("badminton v3 device link: a partial row that a later rally now sits after keeps the label and offers no amend", async ({
  browser,
  request,
}) => {
  test.setTimeout(BUDGET_MS);
  const { fx, secret } = await seedPair(request, "Tail");
  const ctx = await browser.newContext({
    storageState: await consentedAnonymousState(),
    viewport: { width: 390, height: 844 },
  });
  try {
    const page = await ctx.newPage();
    await openDeviceLink(page, secret);

    await rallyWithDrainedDock(page, "home");
    await expect(partialBadge(page)).toHaveAttribute("data-amendable", "true", { timeout: 20_000 });

    // A second rally, to the OTHER side. The first row is now behind it in the
    // fold, so voiding and re-appending it would replay it out of sequence —
    // same points, different match (see `isNewestFoldingEvent`). The badge must
    // fall back to the R7 label rather than offer a correction that corrupts.
    await rallyWithDrainedDock(page, "away");
    await expect.poll(async () => (await ralliesOf(request, fx.fixtureId)).length, { timeout: 60_000 }).toBe(2);

    const badges = partialBadge(page);
    await expect(badges, "both drained rallies are still labelled partial").toHaveCount(2, { timeout: 20_000 });
    // Newest first (`orderedActivity`), so index 0 is the SECOND rally — the
    // tail, still amendable — and index 1 is the one now behind it.
    await expect(badges.nth(0), "the newest drained rally is still amendable").toHaveAttribute(
      "data-amendable",
      "true",
    );
    await expect(
      badges.nth(1),
      "a partial row with a live rally after it must not offer an out-of-sequence correction",
    ).not.toHaveAttribute("data-amendable", "true");
    expect(await badges.nth(1).evaluate((n) => n.tagName), "the refused one is the R7 label, not a dead button").toBe(
      "SPAN",
    );
  } finally {
    await ctx.close();
  }
});
