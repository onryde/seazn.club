// Ribbon copy builder — R1 chassis (Task 3). The ribbon is the pad's only
// always-on history element: every commit answers in plain sport words with
// an inline Undo (design of record:
// docs/superpowers/specs/2026-08-03-scoringpad-v2-design.md). R1 ships the
// FALLBACK path only — no per-sport `pad.<sport>.ribbon.<suffix>` copy
// exists yet in any dictionary. Per-event ribbon sentences land sport-by-
// sport with each conversion wave (R2+); this function already looks them
// up first, so a later wave only has to add dictionary copy + register the
// key in PAD_LABEL_KEYS (scoring-vocab.ts) — it never has to touch this
// file's logic.
//
// Reuses padLabel() (apps/web/src/lib/scoring-vocab.ts:907), the SAME vocab
// path every legacy skin already calls for label text (S7/#427) — see
// .superpowers/sdd/2026-08-15-scorepad-v3-r1-chassis/pins.md §4.
//
// Fix round 1 (review finding 1): the hit/miss branch decision is made by
// PAD_LABEL_KEYS membership, NOT by comparing padLabel's return value to
// `eventType`. A value-comparison collides whenever a REAL per-sport
// translation happens to equal the raw dot-joined event type (e.g. a
// translator pastes the key/type instead of prose) — that would silently
// read as "miss" and route to the generic fallback forever, with nothing
// failing. Membership is authoritative regardless of what the registered
// key's copy actually says.
import { padLabel, PAD_LABEL_KEYS } from "@/lib/scoring-vocab";
import type { MessageKey } from "@/lib/messages";

// Sign-off review 2026-08-17 (D1 + D2, found in a real 320px cricket
// screenshot): `core.start` rendered verbatim as "core.start recorded", and
// every `cricket.ball` row read identically "Ball recorded" regardless of
// outcome. Both fixes land here — see `CORE_RIBBON_KEY` and `buildRibbon`'s
// new `detail` parameter below.

/** Interpolating message lookup — the shape `useMsg()` (client) and
 *  `msgFor()` (server) both hand callers. Taken as a parameter (not called
 *  via a hook internally) so this module stays plain data/functions, safely
 *  importable from a node-environment vitest run with no DictProvider. */
export type MsgFn = (key: MessageKey, vars?: Record<string, string | number>) => string;

export interface Ribbon {
  text: string;
  undoable: true;
}

/**
 * `pad.<sport>.ribbon.<suffix>` for an event type — split on the FIRST `.`
 * only, since `eventType` itself may carry further dots (e.g.
 * "tabletennis.expedite.start" per scoring-vocab.ts's `eventLabel` doc
 * comment). Exported so the key it builds is directly assertable in a test,
 * independent of whether that key happens to be registered in
 * PAD_LABEL_KEYS today.
 */
export function ribbonKeyFor(eventType: string): string {
  const sport = eventType.split(".")[0];
  const suffix = eventType.slice(sport.length + 1);
  return `pad.${sport}.ribbon.${suffix}`;
}

/**
 * D1 fix (sign-off review, 2026-08-17): `core.*` events are KERNEL-owned
 * (packages/engine/src/core/events.ts's own `CORE_EVENT_SCHEMAS` — 9
 * top-level types plus 5 `core.lineup.*` siblings, 14 total, scouted
 * 2026-08-17) and are never part of any sport module's `PadSpec` — so they
 * can never earn a `PAD_LABEL_KEYS` entry the way a real per-sport ribbon
 * key does (`padLabel`'s own doc: keyed by "the engine's own `PadLabel.key`").
 * Before this fix every `core.*` type fell straight to the generic
 * `pad.ribbon.fallback` ("{event} recorded"), printing the raw internal
 * type to a scorer — "core.start recorded" is the exact string a 320px
 * screenshot caught.
 *
 * A separate, LOCAL lookup rather than routing through
 * PAD_LABEL_KEYS/padLabel: that registry lives in scoring-vocab.ts, shared
 * by every sport skin and out of this fix's file grant. Keeping 14 short,
 * closed entries here costs nothing and cannot drift the per-sport
 * mechanism it sits beside.
 *
 * Deliberately an explicit map, not `ribbonKeyFor("core.<x>")`'s own output
 * (`pad.core.ribbon.<x>`) used unconditionally: keeping it explicit means a
 * NEW core type the engine adds later (`CORE_EVENT_SCHEMAS` is a closed set
 * today, but not permanently) degrades to the SAME graceful
 * `pad.ribbon.fallback` every other un-vocab'd type already gets, instead
 * of a `t()` call against a dictionary key that does not exist yet.
 */
const CORE_RIBBON_KEY: Readonly<Record<string, MessageKey>> = {
  "core.start": "pad.ribbon.core.start",
  "core.void": "pad.ribbon.core.void",
  "core.forfeit": "pad.ribbon.core.forfeit",
  "core.abandon": "pad.ribbon.core.abandon",
  "core.finalize": "pad.ribbon.core.finalize",
  "core.note": "pad.ribbon.core.note",
  "core.award": "pad.ribbon.core.award",
  "core.suspend": "pad.ribbon.core.suspend",
  "core.resume": "pad.ribbon.core.resume",
  "core.lineup.substitution": "pad.ribbon.core.lineup.substitution",
  "core.lineup.replacement": "pad.ribbon.core.lineup.replacement",
  "core.lineup.position": "pad.ribbon.core.lineup.position",
  "core.lineup.retirement": "pad.ribbon.core.lineup.retirement",
  "core.lineup.entry": "pad.ribbon.core.lineup.entry",
};

/**
 * Build the ribbon line for one just-committed event.
 *
 * Checks the `core.*` map above first; then looks up
 * `pad.<sport>.ribbon.<suffix>`; falls back to the generic
 * `pad.ribbon.fallback` ("{event} recorded") with the raw event type
 * standing in for a vocab'd name until a later wave gives this event its
 * own copy.
 *
 * `payload`/`names` are accepted — unused on the fallback/per-sport-hit
 * paths — so a later wave's custom ribbon sentence (e.g. "{scorer}
 * scores!") can interpolate a person's name or a payload field without a
 * signature change here.
 *
 * `detail` (D2 fix, sign-off review 2026-08-17): an OPTIONAL,
 * already-localised fragment distinguishing this event from a same-type
 * sibling — "4 runs" vs "Wide" vs "Dot ball" for three `cricket.ball` rows
 * that would otherwise all read identically "Ball recorded" (the exact
 * defect a 320px screenshot caught in the Activity panel). Woven in via
 * the `pad.ribbon.withDetail` key rather than string-concatenated here, so
 * word order stays a per-locale translation decision, not a chassis
 * assumption. Whoever computes `detail` owns the sport vocabulary — this
 * function never inspects `payload` for that purpose itself; see
 * `skins/cricket.tsx`'s `cricketBallDetail` for the first real one, wired
 * through `ActivityPanel`'s `resolveDetail` prop (activity.tsx).
 *
 * `resolveDetail` IS threaded from production today (corrected R8/WS-R — the
 * note here still said "not yet threaded", left over from the D2 fix that
 * could not reach `pad-host.tsx` under its own file grant): `pad-host.tsx`
 * builds the resolver at :1665, hands it to the top ribbon at :1708 and to
 * `ActivityPanel` at :2054, and `activity.tsx:449` calls it per row. Omitting
 * `detail` — still every caller that has no sport-specific fragment to add —
 * reproduces exactly the pre-fix text, byte for byte.
 */
export function buildRibbon(
  eventType: string,
  payload: Record<string, unknown>,
  names: (personId: string) => string,
  t: MsgFn,
  detail?: string,
): Ribbon {
  const coreKey = CORE_RIBBON_KEY[eventType];
  let base: string;
  if (coreKey) {
    base = t(coreKey);
  } else {
    const perSportKey = ribbonKeyFor(eventType);
    base = PAD_LABEL_KEYS.includes(perSportKey as MessageKey)
      ? padLabel(perSportKey, t, eventType)
      : t("pad.ribbon.fallback", { event: eventType });
  }
  return {
    text: detail ? t("pad.ribbon.withDetail", { base, detail }) : base,
    undoable: true,
  };
}
