import { t } from "@/lib/i18n-runtime";
import type { Dict } from "@/lib/i18n-constants";

/**
 * The goal demo island's copy (football, hockey, ice hockey), built on the server. Shared strings are
 * `product.goal.*`; a sport brings its match line, and the name of the card its pad records (`card` is the engine's
 * class key, so a class with no label in the dictionary fails the page test rather than printing a key).
 */
const SHARED = [
  "pad.label", "pad.goal", "pad.fullTime", "pad.undo", "pad.lastNone", "pad.last",
  "mc.label", "mc.live", "mc.fullTime", "mc.won", "mc.draw", "mc.goal", "mc.timeline",
  "table.label", "table.group", "table.p", "table.w", "table.d", "table.l",
  "stream.label", "stream.channel",
] as const;
export type GoalDemoLabels = Record<(typeof SHARED)[number] | "format" | "card", string>;

export function goalDemoLabels(dict: Dict, sport: string, card: string): GoalDemoLabels {
  return {
    ...Object.fromEntries(SHARED.map((k) => [k, t(dict, `product.goal.${k}` as never)])),
    format: t(dict, `sport.${sport}.demo.format` as never),
    card: t(dict, `product.goal.card.${card}` as never),
  } as GoalDemoLabels;
}
