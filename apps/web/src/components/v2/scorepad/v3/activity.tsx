// R2 gap found at sign-off review (2026-08-17): flipping cricket onto the v3
// lane silently DROPPED the legacy pad's event history.
//
// `pad-renderer.tsx` (the legacy renderer, still serving the other 10 sports)
// mounts `<Timeline>` INSIDE the pad, so it appeared on the device-link
// surface too. That component did two jobs, not one:
//
//   1. listed every recorded event (timeline.tsx:251 renders `events.length`);
//   2. let a scorer VOID a past event — and on a device link, specifically
//      their OWN events (pad-renderer.tsx:244's own comment).
//
// `PadHostV3` shipped with neither: its ribbon is built from `latestEvent`
// alone (pad-host.tsx) and its single undo call site passes `latestEvent.id`.
// The normal in-app surface still has `FixtureConsole`'s "Event ledger"
// section to fall back on, but the device-link route (`/score/[token]` ->
// `DeviceScorePad`) mounts NO console chrome, so for cricket the correction
// path disappeared entirely once the ~6s soft-commit hold window elapsed.
//
// This panel restores that capability on the chassis, for every skin — not
// just cricket — so R3-R6 do not each inherit the same hole.
//
// The void RULES are ported from `timeline.tsx:258-261` verbatim rather than
// re-derived, because two of them are not obvious and getting either wrong
// over-grants a destructive action:
//
//   - "voided" is derived by looking for some OTHER event pointing back at
//     this one (`voids === id`), never stored on the target itself;
//   - a `core.void` event is itself never voidable (no un-voiding).
//
// Captions reuse `buildRibbon`, the SAME builder the ribbon already uses, so
// the panel cannot drift into a second event vocabulary — the standing
// programme ruling (no second vocabulary, v2 S2/#430).
//
// Sign-off review 2026-08-17 (a real 320px screenshot of a live cricket
// match) found three defects in this panel, fixed here:
//   D1 — captions fell back to the raw event type for any `core.*` event
//        ("core.start recorded"). Fixed in `ribbon.ts`'s `buildRibbon`.
//   D2 — every `cricket.ball` row read identically "Ball recorded". Fixed
//        via the new `resolveDetail` prop below, threaded into
//        `buildRibbon`'s new `detail` parameter.
//   D3 — `core.start`'s row offered Void, but voiding it is refused
//        server-side once anything has been recorded since. Fixed by
//        `isVoidableEventType` below, replacing the old bare
//        `!== "core.void"` check.
import type { ReactNode } from "react";
import { buildRibbon, type MsgFn } from "./ribbon";

/** The subset of the pipeline's event envelope this panel reads. Deliberately
 *  structural rather than importing `EventEnvelope`: the panel needs four
 *  fields and nothing else, and a narrower prop keeps it testable without
 *  constructing a full envelope. */
export interface ActivityEvent {
  readonly id: string;
  readonly seq: number;
  readonly type: string;
  readonly payload: unknown;
  /** Set only when THIS event IS a void — the id of the event it cancels. */
  readonly voids: string | null;
}

export interface ActivityRowState {
  readonly voided: boolean;
  readonly ownedByMe: boolean;
  readonly canVoid: boolean;
}

/**
 * D3 fix (sign-off review, 2026-08-17): `core.start`'s row offered Void,
 * but voiding it is refused SERVER-SIDE once anything else has been
 * recorded — not because a void's TARGET type is denylisted anywhere
 * (`resolveVoids`, packages/engine/src/core/events.ts, places no type
 * restriction on a void's target beyond "not itself a void, not itself,
 * and earlier in the ledger" — and `requiredFeatureForEvent`,
 * apps/web/src/server/usecases/fidelity.ts, explicitly frees every
 * `core.*` type from entitlement gating too: "start/void/finalize… are
 * free") but because `core.start` is the KERNEL's one mechanism for
 * moving `state.phase` out of `"pre"` (events.ts: "scheduled → in_play"),
 * and sport modules gate their in-play events on that phase — proven
 * directly, not assumed: `cricket.ts`'s own `apply()` throws WRONG_PHASE
 * (`ball in phase "pre"`) for `cricket.ball` once `core.start` is missing
 * from the fold. The same shape recurs for `core.resume`: voiding it
 * leaves an open stoppage forever (nothing else clears it), so every
 * later event outside the kernel's `DURING_STOPPAGE` allowlist then fails
 * WRONG_PHASE on replay too.
 *
 * This panel is CHASSIS-level and sport-agnostic — no fold, no cfg, no
 * module — so it cannot re-run the engine to answer "would voiding THIS
 * event break something already after it in THIS ledger". Given that, and
 * the brief's own fail-safe direction for a DESTRUCTIVE control (hide when
 * unsure), the rule is an ALLOWLIST, not a denylist of the one example
 * (`core.start`) a screenshot happened to catch: every sport-namespaced
 * event stays voidable (this panel's whole reason to exist — correcting a
 * wrong ball), and a `core.*` event is voidable ONLY when the engine's own
 * doc comments say it carries NO STATE EFFECT — `core.note` ("no state
 * effect") and `core.award` ("no state effect on the match itself... a
 * stats-layer fact", "undoable via core.void" in the engine's own words).
 * Every OTHER `core.*` type — including ones this task never proved unsafe,
 * like `core.forfeit`/`core.abandon` — is excluded here too: an allowlist
 * fails safe by construction, where a denylist is exactly the shape that
 * let `core.start` ship broken in the first place.
 */
const ALWAYS_VOIDABLE_CORE_TYPES: ReadonlySet<string> = new Set(["core.note", "core.award"]);

export function isVoidableEventType(type: string): boolean {
  if (!type.startsWith("core.")) return true;
  return ALWAYS_VOIDABLE_CORE_TYPES.has(type);
}

/**
 * Ported from `timeline.tsx:259-261`.
 *
 * `deviceLinkId === null` means "not a device link" — the in-app console
 * scorer, who may void anything (subject to `isVoidableEventType` above).
 * A device link may void ONLY events it recorded itself, which is why
 * `ownEventIds` (the pipeline's own set of locally-submitted ids) is the
 * authority here and not `recordedBy`: a device link has no user identity
 * to compare against.
 */
export function activityRowState(
  event: ActivityEvent,
  all: readonly ActivityEvent[],
  ownEventIds: ReadonlySet<string>,
  deviceLinkId: string | null,
  voidingEnabled: boolean,
): ActivityRowState {
  const voided = all.some((v) => v.voids === event.id);
  const ownedByMe = deviceLinkId === null || ownEventIds.has(event.id);
  return {
    voided,
    ownedByMe,
    canVoid: voidingEnabled && !voided && isVoidableEventType(event.type) && ownedByMe,
  };
}

/** Newest first — `pipeline.events` arrives oldest-first (types.ts says so),
 *  and a scorer correcting a mistake wants the most recent ball at the top,
 *  not after scrolling past the whole innings. Copies before reversing:
 *  `pipeline.events` is the live list, and reversing it in place would
 *  scramble every other consumer's idea of "latest". */
export function orderedActivity(events: readonly ActivityEvent[]): ActivityEvent[] {
  return [...events].reverse();
}

/**
 * R2b (owner ruling, freeHit chip removal): every strictly-older, non-voided
 * event before `rows[index]`, OLDEST FIRST — the order a REPLAY-style
 * derivation needs to walk forward through. `rows` is `orderedActivity`'s
 * own NEWEST-FIRST output, so "older" walks FORWARD through the array —
 * `rows[index + 1]`, `rows[index + 2]`, … — never `index - 1` (that
 * direction is NEWER, the opposite of what "older" means here; this exact
 * reversal is easy to get backwards and still look plausible on screen,
 * which is why it is pinned by a discriminating test rather than just
 * asserted).
 *
 * Skips voided rows for the same reason `activityRowState` derives
 * `voided` in the first place (`some((v) => v.voids === event.id)`,
 * duplicated here rather than calling that function — it also computes
 * ownership/void-permission this caller has no use for): a voided
 * delivery never actually happened as far as match state is concerned, so
 * it must never stand in as "the previous" event for a skin comparing
 * consecutive events.
 *
 * Deliberately does NOT filter by event type — this file is sport-
 * agnostic (this file's own header) and has no vocabulary to filter with.
 * A row in this list may be a structural event (`core.start`, `core.void`,
 * a sport's own non-ball type); a skin that only wants to compare same-KIND
 * events (e.g. cricket's ball-to-ball bowler check) checks `.type` against
 * its own closed set itself once it receives this — same division of
 * labour `SkinDefV3.activityDetail`'s own doc (types.ts) describes.
 *
 * `rows.length - 1` (the oldest surviving row) down to `index + 1` (the
 * nearest older row) is exactly that oldest-first order — so the LAST
 * element of the returned array (when non-empty) is the single nearest-
 * older event a skin comparing consecutive events wants (R2b-cricket-over
 * review fix, item 2: this function used to have a sibling,
 * `previousActivityEvent`, returning exactly that one value directly —
 * review proved the two were always computed from the identical range with
 * the identical voided-skip rule, so `previousActivityEvent` was deleted as
 * redundant; a caller derives its single "previous" fact as
 * `history[history.length - 1]` instead).
 *
 * Empty array at the oldest row, or when every remaining older row is
 * voided — this function is always total, never returns `undefined`.
 */
export function priorActivityEvents(
  rows: readonly ActivityEvent[],
  index: number,
): { type: string; payload: Record<string, unknown> }[] {
  const out: { type: string; payload: Record<string, unknown> }[] = [];
  for (let i = rows.length - 1; i > index; i--) {
    const candidate = rows[i]!;
    const voided = rows.some((v) => v.voids === candidate.id);
    if (!voided) out.push({ type: candidate.type, payload: (candidate.payload ?? {}) as Record<string, unknown> });
  }
  return out;
}

/** The panel scrolls internally past this many rows instead of growing the
 *  page. Matches the legacy `max-h-96` cap (timeline.tsx:257) — about six
 *  rows at the daylight shell's row height, which is roughly one over of
 *  cricket, so a scorer sees the current over without scrolling at all. */
export const ACTIVITY_SCROLL_AFTER_ROWS = 6;

export interface ActivityPanelProps {
  events: readonly ActivityEvent[];
  ownEventIds: ReadonlySet<string>;
  deviceLinkId: string | null;
  personNames: Readonly<Record<string, string>>;
  t: MsgFn;
  /** Omitted on a read-only surface; its absence disables every void
   *  control, which `activityRowState` folds in as `voidingEnabled`. */
  onVoid?: (eventId: string) => void;
  voidingId?: string | null;
  /**
   * D2 fix (sign-off review, 2026-08-17): a per-event distinguishing
   * detail — e.g. runs scored / extra kind / wicket kind for a cricket
   * ball — woven into the ribbon caption via `buildRibbon`'s own `detail`
   * parameter, so two rows of the same event TYPE (three `cricket.ball`
   * rows previously ALL read "Ball recorded", indistinguishable) render
   * different text. This panel stays sport-agnostic on purpose — every
   * sport shares this file — so the SKIN owns the vocabulary; see
   * `skins/cricket.tsx`'s `cricketBallDetail` for the first real one.
   * Optional and additive: omitted, every row keeps exactly today's
   * per-type-only caption.
   *
   * WIRED from `pad-host.tsx`'s own `<ActivityPanel>` call site as
   * `props.skin.activityDetail` (promoted onto `SkinDefV3`, per this
   * comment's own original suggestion) — `legacy-parity.test.ts`'s "3b"
   * case asserts the whole chain, not just this function in isolation.
   *
   * Third parameter `history` (R2b, owner ruling, freeHit chip removal):
   * every strictly older, non-voided row before this one, OLDEST FIRST —
   * `priorActivityEvents` (above). Optional and additive: a `resolveDetail`
   * implementation that only takes two parameters keeps compiling and
   * working unchanged.
   *
   * R2b-cricket-over review fix (item 2): this used to also take a fourth,
   * separate `prev` parameter (the single nearest-older event, computed by
   * this file's own since-deleted `previousActivityEvent`). Review proved
   * `prev` was always exactly `history`'s own last element — both walked
   * `rows[index + 1..]` with the identical voided-skip rule, so the two
   * could never disagree or be independently absent. A caller that needs
   * that single fact reads `history[history.length - 1]` itself; see
   * `priorActivityEvents`'s own doc (above) and `SkinDefV3.
   * activityDetail`/`ActivityDetailContext`'s own doc (types.ts).
   */
  resolveDetail?: ActivityDetailResolver;
}

/**
 * The shape `pad-host.tsx` builds once from `props.skin.activityDetail` and
 * hands to BOTH readers of it — this panel, and `buildTopRibbon` (pad-host.tsx)
 * for the top ribbon. Named rather than inlined for exactly that reason: it was
 * inlined here while only one caller existed, and the second caller (R3/F, F1)
 * was written without it for four waves.
 */
export type ActivityDetailResolver = (
  eventType: string,
  payload: Record<string, unknown>,
  history?: readonly { type: string; payload: Record<string, unknown> }[],
) => string | undefined;

/**
 * The detail for the NEWEST row — the one the TOP RIBBON shows.
 *
 * R3/F (F1). The ribbon and this panel's first row describe the same event, so
 * they must read identically; before this they could not, because the ribbon
 * called `buildRibbon` with no `detail` at all. Resolved through the SAME
 * `orderedActivity` + `priorActivityEvents` pair the panel's own row uses, in
 * this file rather than in `pad-host.tsx`, so the ordering and voided-skip
 * rules have exactly one implementation and cannot fork.
 *
 * `undefined` for an empty stream, and for a skin that declares no
 * `activityDetail` — both of which mean "no detail", not "no ribbon".
 */
export function latestRowDetail(
  events: readonly ActivityEvent[],
  resolveDetail: ActivityDetailResolver | undefined,
): string | undefined {
  if (resolveDetail === undefined) return undefined;
  const rows = orderedActivity(events);
  const newest = rows[0];
  if (newest === undefined) return undefined;
  return resolveDetail(newest.type, (newest.payload ?? {}) as Record<string, unknown>, priorActivityEvents(rows, 0));
}

export function ActivityPanel({
  events,
  ownEventIds,
  deviceLinkId,
  personNames,
  t,
  onVoid,
  voidingId = null,
  resolveDetail,
}: ActivityPanelProps): ReactNode {
  const rows = orderedActivity(events);
  const nameOf = (id: string) => personNames[id] ?? id;

  return (
    <section className="rounded-2xl border border-slate-200 bg-white" data-role="v3-activity">
      <header className="flex items-center justify-between border-b border-slate-100 px-4 py-3">
        <h2 className="text-sm font-semibold text-slate-700">{t("pad.activity.heading")}</h2>
        <span className="text-sm font-medium text-slate-600 tabular-nums" data-role="v3-activity-count">
          {events.length}
        </span>
      </header>

      {rows.length === 0 ? (
        <p className="px-4 py-4 text-sm text-slate-600">{t("pad.activity.empty")}</p>
      ) : (
        // max-h-96 + overflow-y-auto: the panel scrolls INSIDE itself past
        // ACTIVITY_SCROLL_AFTER_ROWS rows so a long innings never grows the
        // page. `overscroll-contain` stops a flick at the list's end from
        // scrolling the page behind it, which on a phone reads as the pad
        // jumping while a scorer is reviewing.
        <ul className="max-h-96 divide-y divide-slate-100 overflow-y-auto overscroll-contain" data-role="v3-activity-list">
          {rows.map((event, index) => {
            const { voided, canVoid } = activityRowState(event, events, ownEventIds, deviceLinkId, !!onVoid);
            const payload = (event.payload ?? {}) as Record<string, unknown>;
            const history = priorActivityEvents(rows, index);
            const detail = resolveDetail?.(event.type, payload, history);
            const caption = buildRibbon(event.type, payload, nameOf, t, detail);
            return (
              <li
                key={event.id}
                className="flex items-center gap-3 px-4 py-2"
                data-role="v3-activity-row"
                data-voided={voided}
                // The row's own event id. Without it a test can only target
                // rows POSITIONALLY, and position lies: the ledger carries
                // structural events (core.start) alongside scoring ones, so
                // "the last row" is not "the oldest ball". Cost one wrong
                // e2e failure to learn.
                data-event-id={event.id}
              >
                <span
                  className={`min-w-0 flex-1 break-words text-sm ${voided ? "text-slate-400 line-through" : "text-slate-700"}`}
                >
                  {caption.text}
                </span>
                {canVoid ? (
                  <button
                    type="button"
                    onClick={() => onVoid?.(event.id)}
                    disabled={voidingId === event.id}
                    data-role="v3-activity-void"
                    className="min-h-11 shrink-0 rounded-lg border border-slate-200 px-3 text-sm font-medium text-slate-700 transition-colors hover:bg-slate-50 disabled:opacity-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-lime-400"
                  >
                    {voidingId === event.id ? t("pad.activity.voiding") : t("pad.activity.void")}
                  </button>
                ) : voided ? (
                  <span className="shrink-0 text-xs font-medium uppercase tracking-wide text-slate-400">
                    {t("pad.activity.voided")}
                  </span>
                ) : null}
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
