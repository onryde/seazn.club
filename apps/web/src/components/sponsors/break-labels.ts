// The labels of the natural breaks a sponsor card fills: ONE map for the On stream tab (a client component) and the sponsor
// report (a server component), so neither copies the other (final review m5). Pure constants - no hooks, no "use client" - so
// both module graphs can read it, like `tier-labels.ts` beside it.
import type { MessageKey } from "@/lib/messages";

/** One label per break kind the engine declares (`naturalBreaks.kinds`; swept against `builtinModules` in the tests).
 *  Typed key map: the i18n house rule bans dynamic `msg()` keys. */
export const BREAK_MSG: Readonly<Record<string, MessageKey>> = {
  half_time: "sponsors.onStream.break.half_time",
  period_end: "sponsors.onStream.break.period_end",
  shootout_break: "sponsors.onStream.break.shootout_break",
  after_goal: "sponsors.onStream.break.after_goal",
  over_end: "sponsors.onStream.break.over_end",
  innings_break: "sponsors.onStream.break.innings_break",
  set_end: "sponsors.onStream.break.set_end",
  timeout: "sponsors.onStream.break.timeout",
  game_end: "sponsors.onStream.break.game_end",
  interval: "sponsors.onStream.break.interval",
  changeover: "sponsors.onStream.break.changeover",
  quarter_end: "sponsors.onStream.break.quarter_end",
};

/** The one fallback, for a kind with no label (a kind a later engine adds before its label lands, or none at all): a
 *  break in play, from the dictionary - never the raw kind. */
export const BREAK_FALLBACK_MSG: MessageKey = "sponsors.break.inPlay";

/** The label key for a break kind: its own, else the fallback. An inherited name (`toString`) is not a kind. */
export function breakMsgKey(kind: string | null): MessageKey {
  return kind !== null && Object.hasOwn(BREAK_MSG, kind) ? BREAK_MSG[kind]! : BREAK_FALLBACK_MSG;
}
