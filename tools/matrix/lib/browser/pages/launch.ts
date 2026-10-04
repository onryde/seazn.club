// Starting a division from the division page's header (Task 5). Product
// facts, read at Step 0 (components/v2/launch-actions.tsx):
//  - `launch-start-division` (:141) renders while the division's scoring is
//    closed (setup, scheduled); it only OPENS StartConfirmDialog, whose
//    confirm is `start-confirm-confirm` (start-confirm-dialog.tsx:81, via
//    ConfirmDialog's `${testId}-confirm`).
//  - start() (:95-130) POSTs /api/v1/divisions/<id>/start with NO body, or
//    `{acknowledge_warnings: true}` on the retry; a refusal coded
//    PUBLISH_UNACKNOWLEDGED — lib/schedule-board.ts:61
//    "SCHEDULE_UNACKNOWLEDGED_WARNINGS" — opens ScheduleGateDialog, whose
//    `board-gate-confirm` (schedule-gate-dialog.tsx:98) is `start(true)` (:188);
//    PUBLISH_BLOCKED (:57) opens it with no way through.
//  - on success: router.push("?tab=fixtures") when fixtures were generated,
//    then router.refresh() — the division is active and the button is gone.
// HttpDriver's start sends acknowledge_warnings up front; the UI asks first
// and acknowledges only when the product says there is something to
// acknowledge — the organiser's path, and the same end state.
import { actAndAwait } from "../respond.ts";
import { TESTID } from "../selectors.ts";
import { RefusedCall, type StartOut } from "../../driver/types.ts";
import { actBudget, awaitScreen, exactPath, navBudget, shoot, visit, type DivisionWhere, type PageCtx } from "./ctx.ts";
import { paths } from "./paths.ts";

/** schedule-board.ts PUBLISH_UNACKNOWLEDGED (pinned). */
export const START_UNACKNOWLEDGED = "SCHEDULE_UNACKNOWLEDGED_WARNINGS";

/** The one refusal the start dialog offers a way through. */
export function isUnacknowledgedStart(e: unknown): boolean {
  return e instanceof RefusedCall && e.code === START_UNACKNOWLEDGED;
}

/** Starts the division through the launch button and its confirmation (and
 *  the warnings gate, when the product raises it); the product's StartOut.
 *  Any other refusal is the product's RefusedCall, unchanged. */
export async function startUi(c: PageCtx, where: DivisionWhere): Promise<StartOut> {
  const { page } = c;
  const t = actBudget(c, 1);
  const nav = navBudget(c);
  const launch = page.getByTestId(TESTID.launchStart.id);
  await visit(c, paths.division(c.orgSlug, where.compSlug, where.divSlug), { control: launch, what: "the division's Start button" });
  await awaitScreen(() => launch.waitFor({ state: "visible", timeout: nav }), "the division's Start button", nav);
  const before = await shoot(c, "04-started-before");
  await launch.click({ timeout: t });
  const want = { method: "POST", path: exactPath(`/api/v1/divisions/${where.divisionId}/start`) };
  let out: StartOut;
  try {
    ({ data: out } = await actAndAwait<StartOut>(page, want, () => page.getByTestId(TESTID.startConfirm.id).click({ timeout: t }), t));
  } catch (e) {
    if (!isUnacknowledgedStart(e)) throw e;
    ({ data: out } = await actAndAwait<StartOut>(page, want, () => page.getByTestId(TESTID.gateConfirm.id).click({ timeout: t }), t));
  }
  if (out.started) await awaitScreen(() => launch.waitFor({ state: "detached", timeout: nav }), "the started division, without its Start button", nav);
  await shoot(c, "04-started", out.started ? before : undefined);
  return out;
}
