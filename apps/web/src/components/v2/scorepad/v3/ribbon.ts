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
// .superpowers/sdd/2026-08-15-scorepad-v3-r1-chassis/pins.md §4. padLabel's
// PAD_LABEL_SET gate means an unregistered key never reaches the real
// translator at all (no dev-mode "missing key" warning spam while R1's
// per-sport keys don't exist), and its return value doubles as a hit/miss
// signal here: called as `padLabel(perSportKey, t, eventType)`, a miss
// echoes `eventType` straight back (the engineLabel we handed it), which
// this treats as "no custom copy yet" and routes to the generic template.
import { padLabel } from "@/lib/scoring-vocab";
import type { MessageKey } from "@/lib/messages";

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
 * Build the ribbon line for one just-committed event.
 *
 * Looks up `pad.<sport>.ribbon.<suffix>` first (split on the FIRST `.` —
 * `eventType` itself may carry further dots, e.g. "tabletennis.expedite.start"
 * per scoring-vocab.ts's `eventLabel` doc comment); falls back to the
 * generic `pad.ribbon.fallback` ("{event} recorded") with the raw event
 * type standing in for a vocab'd name until a later wave gives this event
 * its own copy.
 *
 * `payload`/`names` are accepted now — unused on R1's fallback path — so a
 * later wave's custom ribbon sentence (e.g. "{scorer} scores!") can
 * interpolate a person's name or a payload field without a signature change
 * here.
 */
export function buildRibbon(
  eventType: string,
  payload: Record<string, unknown>,
  names: (personId: string) => string,
  t: MsgFn,
): Ribbon {
  const sport = eventType.split(".")[0];
  const suffix = eventType.slice(sport.length + 1);
  const perSportKey = `pad.${sport}.ribbon.${suffix}`;
  const resolved = padLabel(perSportKey, t, eventType);
  if (resolved !== eventType) {
    return { text: resolved, undoable: true };
  }
  return { text: t("pad.ribbon.fallback", { event: eventType }), undoable: true };
}
