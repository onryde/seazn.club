import { test, expect, type Page, type APIRequestContext } from "@playwright/test";
import {
  activeOrg,
  apiJson,
  fixturePath,
  invalidateOrgEntitlements,
  loginUi,
  seedRosteredFixture,
  setBoolEntitlementOverrideSql,
  setDivisionConfigSql,
  setOrgPlanBySql,
  TAG,
  type RosteredFixture,
} from "./helpers";

// Opt-in per-org "swap-sheet OFF-step enforcement" (owner ruling 2026-08-25).
//
// scorepad-v3-football.spec.ts's own maxSubs test pins TODAY'S permissive
// default on purpose ("a known limit of the R3 chassis fix, not an
// accident"): the OFF step always shows the off-player picker regardless of
// `policyVerdict`, and a refusal only ever surfaces after an off pick is
// made, on the ON step. This file proves the OPPOSITE case the new
// `scoring.swap_off_step_enforcement` entitlement unlocks: once an org holds
// it, the SAME refused verdict is shown on the OFF step itself, before any
// candidate is picked — reusing the ON step's own `data-role="swap-refusal"`
// markup and copy verbatim (swap-sheet.tsx's `shouldRefuseOffStep`).
//
// A FRESH org via `loginUi`, never the shared Pro account most specs
// (including the maxSubs test this one otherwise mirrors) run against under
// the default storageState: granting this entitlement is a standing mutation
// on whichever org it lands on, and the shared org is exactly what
// scorepad-v3-football.spec.ts's own pinned OFF-step assertions run against.
// Mutating it here would flip those assertions out from under that file
// without touching a line of it — the same isolation reason
// e2e/scoring-free.spec.ts also mints a fresh org
// rather than flipping the shared one's plan.
test.describe.configure({ mode: "parallel" });

function pad(page: Page) {
  return page.locator('[data-testid="score-pad"]');
}

function v3Tile(page: Page, id: string) {
  return pad(page).locator(`[data-tile-id="${id}"]`);
}

/** Same shape as scorepad-v3-football.spec.ts's own `ledger`/`countOf` pair —
 *  used below to prove a completed swap actually reached the server, which
 *  neither test in this file needed before it. */
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

async function countOf(request: APIRequestContext, fixtureId: string, type: string): Promise<number> {
  return (await ledger(request, fixtureId)).filter((e) => e.type === type).length;
}

/** Dispatch a real ledger event directly, reading `last_seq` fresh each call.
 *  SETUP only — the one action this test is actually about always goes
 *  through the real pad. Same helper, same posture as
 *  scorepad-v3-football.spec.ts's own `postEvent`. */
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

/** MERGE a few cfg keys into the division's existing config — never replace
 *  it. Same idiom as scorepad-v3-football.spec.ts's own `mergeDivisionConfig`
 *  (setDivisionConfigSql writes the column verbatim, so a bare object would
 *  drop every default the division was created with). Called BEFORE the
 *  first event so no fold has read the old shape. */
async function mergeDivisionConfig(
  request: APIRequestContext,
  divisionId: string,
  patch: Record<string, unknown>,
): Promise<void> {
  const div = await apiJson<{ config: Record<string, unknown> }>(request, `/api/v1/divisions/${divisionId}`);
  if (div.status !== 200 || !div.data) {
    throw new Error(`mergeDivisionConfig: GET division -> ${div.status} ${JSON.stringify(div.error)}`);
  }
  await setDivisionConfigSql(divisionId, { ...div.data.config, ...patch });
}

/** `openLiveConsole` minus the tap, for a fixture whose `core.start` (and
 *  whatever setup follows it) was already posted through `postEvent` — same
 *  helper as scorepad-v3-football.spec.ts's own `openConsoleAlreadyLive`. */
async function openConsoleAlreadyLive(page: Page, fx: RosteredFixture): Promise<void> {
  await page.goto(await fixturePath(page.request, fx.fixtureId));
  await expect(pad(page)).toBeVisible({ timeout: 20_000 });
}

test("football v3: opting in to scoring.swap_off_step_enforcement makes the OFF step refuse immediately, before any candidate is picked", async ({
  page,
}) => {
  test.setTimeout(120_000);

  const email = `e2e-swapoff-${TAG}-${Math.random().toString(36).slice(2, 7)}@example.com`;
  await loginUi(page, email);
  // requirePageAuth on any server page is what auto-provisions "My
  // organization" for a member of none — activeOrg needs that to have
  // already happened (same precondition scorepad-v3-football.spec.ts's own
  // band-gated test documents).
  await page.goto("/dashboard", { waitUntil: "load" });
  const org = await activeOrg(page);
  // W1 (entitlements v18): scoring DEPTH is free now, so `football.sub` needs
  // no plan at all — the Pro upgrade below is retained only because this org
  // is otherwise fresh and the spec is about a chassis flag, not a plan. Layer
  // the ONE override on top: `scoring.swap_off_step_enforcement` is not wired
  // into any plan's entitlement set (owner ruling — it is reachable only via
  // override, never a default-on Pro feature).
  await setOrgPlanBySql({ orgId: org.id }, "pro");
  await setBoolEntitlementOverrideSql(org.id, "scoring.swap_off_step_enforcement", true);
  await invalidateOrgEntitlements(page.request, org.id);

  const fx = await seedRosteredFixture(page.request, {
    label: `V3 SwapOff ${TAG}`,
    sportKey: "football",
    variantKey: "11-a-side",
    home: [
      { fullName: `V3 SO Start1 ${TAG}`, positionKey: "FW" },
      { fullName: `V3 SO Start2 ${TAG}`, positionKey: "MF" },
      { fullName: `V3 SO Bench1 ${TAG}`, slot: "bench" },
    ],
    away: [{ fullName: `V3 SO Away ${TAG}`, positionKey: "GK" }],
  });
  // Same setup as scorepad-v3-football.spec.ts's own maxSubs test: `11-a-side`
  // declares no cap by default, so set one, then consume it with ONE
  // unstamped sub BEFORE the pad ever opens — the second attempt is refused.
  await mergeDivisionConfig(page.request, fx.divisionId, { maxSubs: 1 });
  await postEvent(page.request, fx.fixtureId, "core.start", {});
  await postEvent(page.request, fx.fixtureId, "football.sub", {
    by: fx.homeEntrantId,
    off: fx.personIds[`V3 SO Start1 ${TAG}`]!,
    on: fx.personIds[`V3 SO Bench1 ${TAG}`]!,
  });
  await openConsoleAlreadyLive(page, fx);

  await v3Tile(page, "sub-home").click();
  const swap = pad(page).locator('[data-role="v3-swap"]');
  await expect(swap).toBeVisible({ timeout: 10_000 });

  // The OFF step refuses IMMEDIATELY — no off-candidate tap first. Contrast
  // scorepad-v3-football.spec.ts's own (default-off) maxSubs test, which must
  // click an off-candidate before its ON step shows this SAME string; that
  // spec is untouched and still passes (verified alongside this one) — this
  // org is the only thing that differs.
  await expect(
    swap.locator('[data-role="swap-refusal"]'),
    "an org holding scoring.swap_off_step_enforcement must see the OFF step refuse before any candidate is picked",
  ).toHaveText("1 of 1 substitutions used");
  // The off-player picker must never have rendered at all — proves this is
  // the OFF step refusing, not e.g. an accidental double-tap landing on the
  // ON step.
  await expect(swap.locator("[data-candidate-id]")).toHaveCount(0);
});

test("football v3: opting in to scoring.swap_off_step_enforcement does not block a still-legal substitution — the OFF and ON steps both complete normally", async ({
  page,
}) => {
  test.setTimeout(120_000);

  // Same org setup as the test above — a FRESH org, Pro plan, the override
  // granted — but this fixture never exhausts (or even configures) a cap, so
  // `policyVerdict.ok` stays true throughout. `shouldRefuseOffStep` returns
  // false whenever the verdict is ok regardless of `enforceOffStep`
  // (context-swap.test.ts's own "enforceOffStep=true + an OK verdict" case,
  // lines ~1263-1277) — this proves the SAME thing against the real server,
  // which that render-level test structurally cannot: a fabricated ok
  // verdict there is not proof the server ever produces one.
  const email = `e2e-swapoff-ok-${TAG}-${Math.random().toString(36).slice(2, 7)}@example.com`;
  await loginUi(page, email);
  await page.goto("/dashboard", { waitUntil: "load" });
  const org = await activeOrg(page);
  await setOrgPlanBySql({ orgId: org.id }, "pro");
  await setBoolEntitlementOverrideSql(org.id, "scoring.swap_off_step_enforcement", true);
  await invalidateOrgEntitlements(page.request, org.id);

  const fx = await seedRosteredFixture(page.request, {
    label: `V3 SwapOff OK ${TAG}`,
    sportKey: "football",
    variantKey: "11-a-side",
    home: [
      { fullName: `V3 SOK Start1 ${TAG}`, positionKey: "FW" },
      { fullName: `V3 SOK Start2 ${TAG}`, positionKey: "MF" },
      { fullName: `V3 SOK Bench1 ${TAG}`, slot: "bench" },
    ],
    away: [{ fullName: `V3 SOK Away ${TAG}`, positionKey: "GK" }],
  });
  // NO maxSubs/subWindows config and NO pre-consumed substitution this time —
  // the smaller diff against the test above, and it is what keeps the verdict
  // genuinely ok: `11-a-side` declares neither cap by default
  // (scorepad-v3-football.spec.ts's own maxSubs test makes the same point),
  // so with zero subs used this substitution is legal outright.
  await postEvent(page.request, fx.fixtureId, "core.start", {});
  await openConsoleAlreadyLive(page, fx);

  await v3Tile(page, "sub-home").click();
  const swap = pad(page).locator('[data-role="v3-swap"]');
  await expect(swap).toBeVisible({ timeout: 10_000 });

  // OFF step: unrefused, even though this org opted in — the verdict is ok,
  // so shouldRefuseOffStep must be false. Contrast the test above, whose OFF
  // step shows exactly this markup because ITS verdict is refused.
  await expect(
    swap.locator('[data-role="swap-refusal"]'),
    "a still-legal substitution must show the normal OFF picker even for an org that opted into enforcement",
  ).toHaveCount(0);
  const offId = fx.personIds[`V3 SOK Start1 ${TAG}`]!;
  const onId = fx.personIds[`V3 SOK Bench1 ${TAG}`]!;
  await swap.locator(`[data-candidate-id="${offId}"]`).click();

  // ON step: also unrefused — the same ok verdict backs both steps, and the
  // bench candidate is offered normally.
  await expect(swap.locator('[data-role="swap-refusal"]')).toHaveCount(0);
  await expect(swap.locator(`[data-candidate-id="${onId}"]`)).toBeVisible();
  await swap.locator(`[data-candidate-id="${onId}"]`).click();

  // The sheet closes immediately once both picks are made — pad-host.tsx's
  // onSwap calls setOpenSwapId(null) before dispatching the built event.
  await expect(swap).toHaveCount(0);

  // ...and the real server round-trip lands the swap. `football.sub` has no
  // dock content (buildDock returns null for it, football.tsx), so nothing
  // flushes the hold early here — this waits out the ~6s soft-commit window
  // (queue.ts's HOLD_MS) rather than clicking a "Send now" that does not
  // exist for this event type.
  await expect.poll(async () => countOf(page.request, fx.fixtureId, "football.sub"), { timeout: 20_000 }).toBe(1);
  const sub = (await ledger(page.request, fx.fixtureId)).find((e) => e.type === "football.sub")!;
  expect(sub.payload).toMatchObject({ by: fx.homeEntrantId, off: offId, on: onId });
});
