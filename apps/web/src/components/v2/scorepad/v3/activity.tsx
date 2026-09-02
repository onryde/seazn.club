"use client";

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
import { useState, type ReactNode } from "react";
import { ClientTime } from "@/components/client-time";
import { describeEvent, type EventDescription } from "@/lib/event-copy";
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
  /**
   * R7/C1 — provenance, merged in from the page-level ledger this wave
   * DELETES (`fixture-console.tsx`'s hand-rolled `<ul>`). Both optional
   * because they are facts about the MOUNT, not about the pad: the console
   * has the full ledger row and can answer them, and it is the surface a
   * dispute is settled on.
   *
   * ISO, rendered through `ClientTime` — never `toLocaleTimeString` in the
   * render body, which is what made the console SSR a wall-clock string the
   * viewer's browser then disagreed with (fixture-console-ssr.test.tsx).
   */
  readonly recordedAt?: string | null;
  /**
   * The provenance line's already-RESOLVED human label — "Dana Okafor", or
   * the scorer-vocabulary phrase for a handed device. Resolved by the mount
   * rather than here on purpose: `recordedBy` is a USER id (not a person id,
   * so `personNames` cannot answer it) and "this row came from a device link"
   * is carried by `score_events.device_link_id`, which never survives into
   * the pad pipeline's `EventEnvelope` at all. A panel that tried to derive
   * either would be inventing a second provenance vocabulary.
   */
  readonly recordedByLabel?: string | null;
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
  authority = false,
): ActivityRowState {
  const voided = all.some((v) => v.voids === event.id);
  const ownedByMe = deviceLinkId === null || ownEventIds.has(event.id);
  return {
    voided,
    ownedByMe,
    canVoid:
      voidingEnabled &&
      !voided &&
      (authority ? event.type !== "core.void" : isVoidableEventType(event.type)) &&
      ownedByMe,
  };
}

/**
 * R8/#675 — is `event` the newest thing in this ledger that the FOLD still
 * applies? `all` is oldest-first (`ActivityPanelProps.events`; the panel's own
 * `orderedActivity` reverses a COPY for display and never mutates this).
 *
 * WHY A CHASSIS-LEVEL RULE AND NOT A NICETY. An amendment (see `canAmendRow`
 * below) is a `core.void` of the original plus a re-append of the same event
 * carrying the completed payload — the engine's OWN correction model, in its
 * own words: "Void back to the mistake, then re-append"
 * (packages/engine/src/core/events.ts, §4.1). Append-only means the
 * replacement lands at the TAIL. That is order-PRESERVING only while nothing
 * the fold still applies sits after the target; amend an older row and the
 * replacement replays out of sequence. In badminton that silently rewrites who
 * served every rally since — same points, different match. The engine says as
 * much for a STAMPED event, where it refuses the re-append outright
 * (`NON_MONOTONIC_TIME`); for an unstamped one nothing refuses, which is worse,
 * so the refusal has to live here.
 *
 * Two kinds of row are skipped, and both matter. A `core.void` is not a folding
 * event at all (`resolveVoids` strips every one before a module sees anything),
 * and a row some later `core.void` names is not folded either — so a mistake
 * that was voided leaves the row BEFORE it amendable again.
 */
export function isNewestFoldingEvent(event: ActivityEvent, all: readonly ActivityEvent[]): boolean {
  for (let i = all.length - 1; i >= 0; i--) {
    const candidate = all[i] as ActivityEvent;
    if (candidate.type === "core.void") continue;
    if (all.some((v) => v.voids === candidate.id)) continue;
    return candidate.id === event.id;
  }
  return false;
}

/**
 * R8/#675 (owner ruling) — may this row's "Partial" badge be TAPPED to reopen
 * its detail dock and supply what the hold window cut short?
 *
 * `partial` is passed in rather than recomputed: this file is chassis-level and
 * sport-agnostic (this file's own header) and has no dock vocabulary to derive
 * it from — `pad-host.tsx`'s `isPartialDockAnswer` is the one place that can,
 * and the panel already receives its answer as the `isPartial` prop.
 *
 * `amendEnabled` is the caller wiring an `onAmend` handler at all. The organiser
 * console does not: it renders this panel one level out from any pad, so it has
 * no skin, no `PadHostView` and no queue to hold a replacement in. There the
 * badge stays exactly the label R7 shipped.
 *
 * `isVoidableEventType` is re-applied deliberately even though a `core.*` event
 * has no dock and so can never be partial: an amendment VOIDS the original, and
 * a control that voids must obey the same allowlist the Void button does — a
 * second, quietly weaker path to the same destructive primitive is exactly the
 * shape that let `core.start` ship voidable in the first place.
 */
export function canAmendRow(
  event: ActivityEvent,
  all: readonly ActivityEvent[],
  ownEventIds: ReadonlySet<string>,
  deviceLinkId: string | null,
  heldEventId: string | null,
  amendEnabled: boolean,
  partial: boolean,
): boolean {
  if (!amendEnabled || !partial) return false;
  // NEVER the row whose hold window is STILL OPEN, and this is not a nicety.
  // `submitHeld` puts its entry into `pendingEnvelopes` immediately, so a
  // just-tapped event is already a row in this panel — unvoided, owned, newest,
  // and (until a chip is tapped) partial, which is every other condition here.
  // Its detail dock is on screen directly below it, so a second affordance for
  // the same question is at best redundant; and taking it would submit a
  // `core.void` naming a CLIENT-fabricated id the server has never seen, then
  // re-hold a duplicate behind it. `decideUndo` draws the same line for the
  // Void button — a held row is DROPPED, never voided — and this is that rule
  // for the badge. `held?.id` is the host's, passed down exactly as
  // `ribbonUndoTarget` already takes it (pad-host.tsx).
  if (heldEventId !== null && event.id === heldEventId) return false;
  // `voidingEnabled: false` — this reads `ownedByMe` only, which that flag does
  // not touch; passing true would imply this is asking about the Void button,
  // which it is not.
  const { ownedByMe } = activityRowState(event, all, ownEventIds, deviceLinkId, false);
  // NO `!voided` term, deliberately, and it is not an omission: a voided row can
  // never be the newest FOLDING event, because `isNewestFoldingEvent` skips
  // every voided candidate before it compares ids. A `!voided` here read as a
  // guard and behaved as decoration — the mutation sweep for this task removed
  // it and not one assertion moved. The implication is pinned by its own test
  // ("a voided row is never the newest folding event") rather than restated as
  // a second condition nothing can kill.
  return ownedByMe && isVoidableEventType(event.type) && isNewestFoldingEvent(event, all);
}

/** What the amber badge is for one row: absent, the R7 label, or the R8
 *  control. Three states rather than two booleans, so the render cannot show a
 *  tappable badge on a row that should carry none. */
export type PartialBadgeKind = "none" | "label" | "amend";

/**
 * R8/#675 — the badge decision, lifted OUT of the JSX.
 *
 * It lives here for the reason detail-dock.tsx's own header gives for
 * `dockController`: apps/web vitest is `environment: "node"` with no jsdom, so
 * a rule left inside the render is a rule nothing in this workspace can
 * execute. Both halves of the ruling below shipped as one-line conditions in
 * markup once already, which is how the badge went a whole wave being a label
 * nobody could tap.
 *
 * `"none"` on a VOIDED row is the honesty half of the ruling ("a row that has
 * been completed should no longer read Partial"). `isPartial` reads the payload
 * and nothing else, so the row an amendment SUPERSEDED — struck through, no
 * longer folded, its payload still exactly as incomplete as it was — went on
 * reading "Partial" forever beside the completed row that replaced it. A
 * retracted record is not an incomplete one, and a badge that says otherwise
 * tells a scorer there is still work to do on a row they have already fixed.
 */
export function partialBadge(
  event: ActivityEvent,
  all: readonly ActivityEvent[],
  ownEventIds: ReadonlySet<string>,
  deviceLinkId: string | null,
  heldEventId: string | null,
  amendEnabled: boolean,
  isPartial: ((eventType: string, payload: Record<string, unknown>) => boolean) | undefined,
): PartialBadgeKind {
  const partial = isPartial?.(event.type, (event.payload ?? {}) as Record<string, unknown>) ?? false;
  if (!partial) return "none";
  const { voided } = activityRowState(event, all, ownEventIds, deviceLinkId, false);
  // The voided suppression is SCOPED TO THE SURFACE THAT CAN AMEND, and that
  // scoping is a controller ruling from fix round 1 rather than a refinement.
  //
  // It reads as an honesty rule in both directions and they disagree. Where the
  // amendment exists, a voided partial row is one the scorer JUST SUPERSEDED —
  // struck through, no longer folded, sitting directly above the completed row
  // that replaced it — and leaving it reading "Partial" tells them there is
  // still work to do on a row they have already fixed. Where the amendment does
  // NOT exist (the organiser console, which mounts this panel outside any pad
  // and wires no `onAmend`), the same row is not "superseded" at all: nothing on
  // that screen could have amended it, and R7-42/F put the label there
  // deliberately so an organiser can see what the courtside scorer left
  // incomplete — including on a row somebody later voided.
  //
  // The first cut suppressed it globally and so quietly deleted a label from a
  // surface this wave is not shipping to. Keyed on `amendEnabled` — the same
  // flag that decides whether the badge is a control at all — so the two can
  // never drift into disagreeing about which surface this is.
  if (voided && amendEnabled) return "none";
  return canAmendRow(event, all, ownEventIds, deviceLinkId, heldEventId, amendEnabled, true) ? "amend" : "label";
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
   * R7/C review fix #1 — "a Void that will refuse must LOOK unavailable".
   *
   * The console gates its ledger on `busy || padSyncing` (fixture-console.tsx):
   * acting on a half-refreshed ledger sends a stale `expected_seq` and earns a
   * 409 where a clean void was expected. C1 carried that rule over as an early
   * `return` inside `onVoid` and nothing else, which made every row's Void a
   * DEAD TAP for the width of a resync — `setPadSyncing(true)` fires after
   * every pad event, so a live console opens that window on every tap, and the
   * button stayed bright, hover-able and silent.
   *
   * Deliberately a whole-panel flag rather than a per-row one: the condition it
   * carries is about the LEDGER's freshness, not about any one event, so a
   * per-row shape would invite a caller to disable one row and leave its
   * neighbours lying. `voidingId` stays the per-row control, for the single row
   * whose own void is in flight.
   *
   * Defaults false, and the device link (pad-host.tsx) passes nothing — its
   * pipeline has no separate resync to be stale against.
   */
  voidDisabled?: boolean;
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
  /**
   * R7-42/F (owner ruling on P-5, `_INDEX.md`): "label the stat as partial
   * wherever it surfaces" — a held submission whose hold drained before a
   * dock question ever got answered records LESS than the scorer would
   * have given it time to. Mirrors `resolveDetail`'s own shape (a per-row
   * resolver the CALLER supplies) rather than a boolean on `ActivityEvent`:
   * this panel is chassis-level and sport-agnostic (this file's own
   * header) and has no dock vocabulary of its own to derive "partial"
   * from — `pad-host.tsx`'s `isPartialDockAnswer` is the one place that
   * calls the skin's own `dock()` to answer it.
   *
   * Optional and additive: omitted, every row renders exactly as before —
   * the SAME posture `resolveDetail` above takes.
   */
  isPartial?: (eventType: string, payload: Record<string, unknown>) => boolean;
  /**
   * R8/#675 (owner ruling) — the badge R7-42/F shipped is a LABEL ONLY: the
   * row's one action was Void, so a rally whose hold drained before anyone
   * named the scorer had the attribution gone with no way back. Wiring this
   * turns the badge itself into the affordance ("make the badge the affordance
   * rather than adding a second row action" — a 320px row already carries
   * Void), and the host answers it by reopening THAT event's detail dock.
   *
   * Optional, exactly as `isPartial` above and for the same reason: the
   * organiser console mounts this panel with no pad behind it, so it passes
   * nothing and every badge there renders as the plain label it already was.
   * `canAmendRow` reads the mere presence of this handler as `amendEnabled`.
   */
  onAmend?: (eventId: string) => void;
  /** The row whose HOLD window is still open, if any — `pad-host.tsx`'s
   *  `held?.id`. Its dock is already on screen, so its badge stays a label; see
   *  `canAmendRow` for why offering the amend there would be actively wrong.
   *  Omitted by a surface with no pad behind it (the console), where nothing is
   *  ever held. */
  heldEventId?: string | null;
  /** The row whose amendment is in flight — its badge is inert until the void
   *  and the re-append are both enqueued. `voidingId`'s twin, and separate
   *  from it on purpose: the two controls can never be busy for the same
   *  reason, and one shared flag would let either disable the other. */
  amendingId?: string | null;
  /**
   * R7/C1 — this mount speaks for the organisation, not for one handed
   * device: the console. It widens the void rule back to what the DELETED
   * page-level ledger allowed (anything that is not itself a `core.void`),
   * so consolidating the two panels takes no capability away from the
   * console — undoing a mistaken `core.abandon` from its own row still
   * works, and `scoring.spec.ts` pins that an abandon stays reversible.
   *
   * `false` (the device link) keeps `isVoidableEventType`'s allowlist, and
   * the reasoning for it is unchanged and still correct: that surface cannot
   * re-run the engine to answer "would voiding THIS break something later in
   * the ledger", it has no chrome to repair a mistake with, and a destructive
   * control there must fail safe. The console has the full ledger, the audit
   * strip and an organiser looking at it.
   *
   * It does NOT widen `ownedByMe` — a device link is still confined to its
   * own rows, because that flows from `deviceLinkId`, not from this.
   */
  authority?: boolean;
  /**
   * Rendered inside the panel, under the rows — the audit strip on the
   * console (`Ledger verified ✓` / `Download audit`), nothing on the device
   * link. A SLOT rather than audit props: the panel is chassis-level and
   * sport-agnostic, entitlement and chain-verification are neither, and the
   * device link simply passes nothing, which is what "only when mounted with
   * authority" has to mean structurally rather than by a flag it could get
   * wrong.
   */
  footer?: ReactNode;
  /** Phone composition (spec §3.9): below `md` show only the latest row until
   *  the scorer taps the toggle. At `md` and up the toggle is not rendered and
   *  no row is hidden — desktop markup is what it was. Omitted = today. */
  collapsible?: boolean;
}

/**
 * The 3px left stripe that replaced the coloured type CHIP (R7/C1, design of
 * record). The chip repeated the row's own sentence — a row reading "Card
 * shown — Yellow card" carried a "Yellow card" badge beside it — so the type
 * survives as colour alone, which encodes it at a glance without saying it
 * twice.
 *
 * The tone comes from `describeEvent` (lib/event-copy.ts), the SAME classifier
 * the deleted page panel tinted its chip with, so the stripe cannot become a
 * third event vocabulary. Only its `tone` is read; the words stay the pad's
 * (`buildRibbon`), which is the standing no-second-vocabulary ruling.
 */
const TONE_STRIPE: Record<EventDescription["tone"], string> = {
  start: "border-l-sky-400",
  score: "border-l-emerald-500",
  card: "border-l-amber-400",
  period: "border-l-purple-400",
  admin: "border-l-red-400",
  void: "border-l-amber-300",
  note: "border-l-slate-300",
};

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
  voidDisabled = false,
  resolveDetail,
  isPartial,
  onAmend,
  amendingId = null,
  heldEventId = null,
  authority = false,
  footer,
  collapsible = false,
}: ActivityPanelProps): ReactNode {
  const rows = orderedActivity(events);
  const nameOf = (id: string) => personNames[id] ?? id;
  const [expanded, setExpanded] = useState(false);
  // `rows` is `orderedActivity`'s NEWEST-FIRST output (this file's own doc,
  // above `latestRowDetail`) — a bare reverse of the chronological `events`
  // list, not a seq sort — so the newest row is simply `rows[0]`. No reduce
  // needed, and no risk of picking `events[0]` (the OLDEST entry) instead.
  const latestId = rows[0]?.id ?? null;
  const collapsed = collapsible && !expanded;

  return (
    <section className="rounded-2xl border border-slate-200 bg-white" data-role="v3-activity">
      <header className="flex items-center justify-between border-b border-slate-100 px-4 py-3">
        <h2 className="text-sm font-semibold text-slate-700">{t("pad.activity.heading")}</h2>
        <span className="flex items-center gap-2">
          <span className="text-sm font-medium text-slate-600 tabular-nums" data-role="v3-activity-count">
            {events.length}
          </span>
          {collapsible && rows.length > 1 && (
            <button
              type="button"
              data-role="v3-activity-toggle"
              aria-expanded={expanded}
              aria-controls="v3-activity-list"
              aria-label={t(expanded ? "pad.activity.showLatest" : "pad.activity.showAll")}
              onClick={() => setExpanded((v) => !v)}
              className="flex h-11 w-11 items-center justify-center rounded-lg text-slate-600 transition-colors hover:bg-slate-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-lime-400 md:hidden"
            >
              <span aria-hidden="true">{expanded ? "▴" : "▾"}</span>
            </button>
          )}
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
        <ul
          id="v3-activity-list"
          className="max-h-96 divide-y divide-slate-100 overflow-y-auto overscroll-contain"
          data-role="v3-activity-list"
        >
          {rows.map((event, index) => {
            const { voided, canVoid } = activityRowState(
              event,
              events,
              ownEventIds,
              deviceLinkId,
              !!onVoid,
              authority,
            );
            const payload = (event.payload ?? {}) as Record<string, unknown>;
            const history = priorActivityEvents(rows, index);
            const detail = resolveDetail?.(event.type, payload, history);
            const caption = buildRibbon(event.type, payload, nameOf, t, detail);
            // R8/#675 — one pure decision, three states; see `partialBadge`.
            const badge = partialBadge(event, events, ownEventIds, deviceLinkId, heldEventId, !!onAmend, isPartial);
            const stripe = TONE_STRIPE[describeEvent(event.type, payload, personNames, t).tone];
            const provenance = Boolean(event.recordedAt) || Boolean(event.recordedByLabel);
            return (
              <li
                key={event.id}
                className={`flex items-start gap-3 border-l-[3px] px-4 py-2 ${stripe}${
                  collapsed && event.id !== latestId ? " max-md:hidden" : ""
                }`}
                data-role="v3-activity-row"
                data-voided={voided}
                // The row's own event id. Without it a test can only target
                // rows POSITIONALLY, and position lies: the ledger carries
                // structural events (core.start) alongside scoring ones, so
                // "the last row" is not "the oldest ball". Cost one wrong
                // e2e failure to learn.
                data-event-id={event.id}
              >
                {/* #seq, merged in from the deleted page panel — the one
                    handle a dispute or a support call has on "which entry".
                    Hidden for a seq the pad only GUESSED: a still-held tap
                    carries `expectedSeq + 1` (use-pad-pipeline.ts), which is
                    a prediction, not a ledger position. */}
                {event.seq > 0 && (
                  <span
                    data-role="v3-activity-seq"
                    className="mt-px shrink-0 font-mono text-xs tabular-nums text-slate-500"
                  >
                    #{event.seq}
                  </span>
                )}
                <span
                  data-role="v3-activity-caption"
                  className={`min-w-0 flex-1 break-words text-sm ${voided ? "text-slate-400 line-through" : "text-slate-700"}`}
                >
                  {caption.text}
                  {badge !== "none" &&
                    // R7-42/F — "the resulting Activity row must be
                    // labelled partial — visibly, in words". `title` carries
                    // the WHY (the same `.hint` convention this pad already
                    // uses on the clock-nudge controls, pad-host.tsx), so
                    // the compact badge stays scannable while the reason is
                    // one hover/inspect away.
                    //
                    // R8/#675 (owner ruling) — where the amendment is actually
                    // available the SAME mark becomes the control: same amber,
                    // same word, same `data-role` (so every existing reader
                    // still finds it), and NO second row action, because a
                    // 320px row already carries #seq, a caption, a provenance
                    // line and Void and cannot afford another control beside
                    // them.
                    //
                    // COMPOSED AT 320 FIRST, and the two constraints that
                    // shaped it pull in opposite directions. It must PAINT at
                    // 44px: `scorepad-a11y-kit.ts` gates every operable target
                    // inside `[data-testid="score-pad"]` on `boundingBox`, and
                    // says in its own words that paint "is still the right
                    // primitive for the 44px floor… the rendered target a thumb
                    // aims at". An invisible overlay would satisfy a hit-test
                    // and leave that gate a latent red the first sweep to catch
                    // a partial row on screen. But it must ALSO not inflate the
                    // caption's own reading line to 44px, which is what an
                    // inline 44px pill does to every partial row.
                    //
                    // Both are satisfied by taking it OUT of the text flow onto
                    // its own line — a `block` wrapper, the exact shape the
                    // provenance line below already uses inside this same
                    // caption. The caption reads at its natural height, the
                    // control is a real thumb target directly under the row it
                    // repairs, and `w-fit` inside the caption's `min-w-0
                    // flex-1` column means it can never widen the row: at 320
                    // the pill is ~100px against a ~230px column.
                    (badge === "amend" ? (
                      <span className="mt-1 block">
                        <button
                          type="button"
                          onClick={() => onAmend?.(event.id)}
                          disabled={amendingId === event.id}
                          data-role="v3-activity-partial"
                          data-amendable="true"
                          // The accessible name says what the TAP does —
                          // "Partial" alone names a state, and a button named
                          // for a state tells a screen-reader user nothing
                          // about the repair. One string carries both halves
                          // (the R7 hint's WHY plus the invitation) so `title`
                          // and `aria-label` cannot drift into two different
                          // explanations.
                          aria-label={t("pad.activity.partial.amend")}
                          title={t("pad.activity.partial.amend")}
                          style={{ minHeight: 44 }}
                          // `minHeight` as an explicit style, not `min-h-11`:
                          // the chassis controls this gate already measures
                          // (detail-dock.tsx's chips, tile-grid.tsx) set it the
                          // same way, so the floor cannot be lost to a purge of
                          // an unused Tailwind class. `max-w-full` + `w-fit`
                          // keeps a long localisation shrinking rather than
                          // pushing the row wide; no `truncate` anywhere in
                          // this row, so no nowrap width floor to pair
                          // `min-w-0` against.
                          className="inline-flex w-fit max-w-full items-center gap-1.5 rounded-full bg-amber-100 px-3 py-1 text-[11px] font-semibold uppercase tracking-wide text-amber-700 transition-colors hover:bg-amber-200 disabled:opacity-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-lime-400"
                        >
                          {/* A plain chevron, the same "there is more here"
                              signal the web already reads without colour — and
                              a SHAPE rather than a tone, for the reason
                              `DockChip.kind` gives (detail-dock.tsx): shape is
                              legible in peripheral vision before colour is,
                              which is what a timed courtside scan needs. */}
                          <svg
                            aria-hidden="true"
                            viewBox="0 0 16 16"
                            className="h-3 w-3 shrink-0"
                            fill="none"
                            stroke="currentColor"
                            strokeWidth={2.25}
                            strokeLinecap="round"
                            strokeLinejoin="round"
                          >
                            <path d="M6 3.5l5 4.5-5 4.5" />
                          </svg>
                          <span className="min-w-0 break-words">{t("pad.activity.partial")}</span>
                        </button>
                      </span>
                    ) : (
                      <span
                        data-role="v3-activity-partial"
                        title={t("pad.activity.partial.hint")}
                        className="ml-1.5 inline-block rounded-full bg-amber-100 px-1.5 py-0.5 align-middle text-[10px] font-semibold uppercase tracking-wide text-amber-700"
                      >
                        {t("pad.activity.partial")}
                      </span>
                    ))}
                  {provenance && (
                    <span
                      data-role="v3-activity-provenance"
                      className="mt-0.5 block text-xs font-normal text-slate-500 no-underline max-md:truncate"
                    >
                      {event.recordedAt ? <ClientTime value={event.recordedAt} mode="time" /> : null}
                      {event.recordedAt && event.recordedByLabel ? " · " : null}
                      {event.recordedByLabel
                        ? t("pad.activity.recordedBy", { name: event.recordedByLabel })
                        : null}
                    </span>
                  )}
                </span>
                {canVoid ? (
                  <button
                    type="button"
                    onClick={() => onVoid?.(event.id)}
                    disabled={voidDisabled || voidingId === event.id}
                    data-role="v3-activity-void"
                    className="min-h-11 min-w-11 shrink-0 rounded-lg border border-slate-200 px-3 text-sm font-medium text-slate-700 transition-colors hover:bg-slate-50 disabled:opacity-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-lime-400"
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

      {/* Authority-only, by construction: the device link passes no footer.
          See `ActivityPanelProps.footer`. */}
      {footer && <div className="border-t border-slate-100 px-4 py-3">{footer}</div>}
    </section>
  );
}
