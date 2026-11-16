import { t } from "@/lib/i18n-runtime";
import type { Dict } from "@/lib/i18n-constants";

/**
 * The rally demo island's copy. Built on the server and handed down, because rally-demo.tsx is a client module. The
 * shared strings are `product.rally.*`; a sport brings only its own word for a set ("Game" in badminton and table
 * tennis, "Set" in volleyball) and its match line.
 */
const SHARED = [
  "pad.label", "pad.point", "pad.undo", "pad.lastNone", "pad.last",
  "mc.label", "mc.live", "mc.won", "mc.toWin",
  "table.label", "table.group", "table.p", "table.w", "table.l",
  "stream.label", "stream.channel", "stream.live", "stream.final",
] as const;
const OWN = ["unit", "units", "format"] as const;
export type RallyDemoLabels = Record<(typeof SHARED)[number] | (typeof OWN)[number], string>;

export function rallyDemoLabels(dict: Dict, sport: string): RallyDemoLabels {
  return {
    ...Object.fromEntries(SHARED.map((k) => [k, t(dict, `product.rally.${k}` as never)])),
    ...Object.fromEntries(OWN.map((k) => [k, t(dict, `sport.${sport}.demo.${k}` as never)])),
  } as RallyDemoLabels;
}
