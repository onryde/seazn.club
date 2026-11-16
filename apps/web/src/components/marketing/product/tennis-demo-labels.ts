import { t } from "@/lib/i18n-runtime";
import type { Dict } from "@/lib/i18n-constants";

/** The tennis demo island's copy, built on the server (`product.tennis.*`). */
const L = [
  "pad.label", "pad.format", "pad.point", "pad.undo", "pad.lastNone", "pad.last", "pad.games", "ad",
  "mc.label", "mc.live", "mc.final", "mc.won", "mc.status", "mc.sets",
  "table.label", "table.group", "table.p", "table.w", "table.l",
  "stream.label", "stream.channel",
] as const;
export type TennisDemoLabels = Record<(typeof L)[number], string>;

export function tennisDemoLabels(dict: Dict): TennisDemoLabels {
  return Object.fromEntries(L.map((k) => [k, t(dict, `product.tennis.${k}` as never)])) as TennisDemoLabels;
}
