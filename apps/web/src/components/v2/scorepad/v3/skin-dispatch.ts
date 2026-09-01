// R8 discharge — migrated out of `../skins/types.ts` (the v2 skin-contract
// file, deleted in this same task once `createSkinDispatch` was its last
// live export). That file's other exports (`SkinProminence`, `SkinGroup`,
// `SkinHeaderField`, `SkinHeader`, `SkinLayoutCtx`, `SkinLayout`,
// `SkinProps`, `SkinDef`, `layoutActionTypes`, `layoutActionTypesAt`,
// `actionsByType`, `actionByType`) had zero external importers by the time
// R7 demolished the v2 skin surface (`cricket-skin.tsx`, `football-skin.tsx`,
// `period-skin.tsx`, `racquet-skin.tsx` — all already gone from disk), so
// they died with the file rather than moving here — verified with
// `git grep -a`, not merely assumed; see task-A-report.md for the evidence.
// `createSkinDispatch` is the one export v3 still uses (`pad-host.tsx`'s
// dispatch gateway) — this file carries it forward along with its own real
// dependencies: the `SkinDispatch` return type and the private
// `KERNEL_DISPATCHABLE` set.
import { LINEUP_EVENT_SCHEMAS } from "@seazn/engine/core";
import type { PadView } from "../view-model";

/**
 * Chassis dispatch, narrowed. `submit` itself (use-pad-pipeline.ts:122) accepts
 * any string; this refuses a type the current view does not declare, so
 * "skin invents an event type" fails loudly at the call site instead of
 * reaching the transport and 422-ing against the server's zod schema.
 */
export type SkinDispatch = (type: string, payload: unknown) => Promise<void>;

/**
 * The KERNEL-owned lineup family, always dispatchable.
 *
 * R5 (volleyball libero, found in a browser — the swap sheet closed and wrote
 * NOTHING): the declared-set gate below is keyed on `view.panels`, which is
 * built from the sport MODULE's `PadSpec`. `core.*` events are not part of any
 * module's spec and never can be — `padLabel`'s registry is keyed by the
 * engine's own per-sport `PadLabel.key`, and `ribbon.ts`'s `CORE_RIBBON_KEY`
 * exists precisely because these types can never earn one. So the gate as
 * written was not "a skin may not invent an event type"; it was a categorical
 * ban on a skin emitting ANY core event, including the five the kernel
 * validates itself (`LINEUP_EVENT_SCHEMAS`, engine `core/lineup.ts`).
 *
 * That ban is not what the gate is for. Its own doc says the point is to fail
 * loudly rather than "reaching the transport and 422-ing against the server's
 * zod schema" — and a `core.lineup.*` event does NOT 422: it validates against
 * `CORE_EVENT_SCHEMAS` and folds cleanly (verified by folding the exact payload
 * `volleyball.tsx`'s `buildLiberoEvent` builds). The chassis already expects
 * these on screen: `ribbon.ts` maps all five to their own ribbon copy.
 *
 * Sourced from the engine rather than spelled here, so a sixth lineup type the
 * kernel adds later is admitted with it instead of silently going inert the way
 * the libero swap did. Deliberately NOT `type.startsWith("core.")` — `core.void`,
 * `core.finalize` and friends are chassis/host business, and a skin reaching for
 * one still fails loudly.
 */
const KERNEL_DISPATCHABLE: ReadonlySet<string> = new Set(Object.keys(LINEUP_EVENT_SCHEMAS));

/**
 * Wraps the chassis `submit` so a skin can only ever emit an action the view in
 * front of it declares. Not defence against a typo alone: it is the structural
 * answer to "a skin bypassing chassis dispatch", because a skin has no other
 * way to send -- PadRenderer never hands a skin `submit` itself.
 */
export function createSkinDispatch(
  view: PadView,
  submit: (type: string, payload: unknown) => Promise<void>,
): SkinDispatch {
  const declared = new Set(view.panels.flatMap((panel) => panel.actions.map((action) => action.type)));
  return async (type, payload) => {
    if (!declared.has(type) && !KERNEL_DISPATCHABLE.has(type)) {
      throw new Error(
        `skin dispatched an action the spec does not declare at this phase: ${type}. ` +
          `Declared here: ${[...declared].sort().join(", ") || "(none)"}`,
      );
    }
    await submit(type, payload);
  };
}
