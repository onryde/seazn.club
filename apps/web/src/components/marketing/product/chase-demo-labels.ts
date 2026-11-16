import { t } from "@/lib/i18n-runtime";
import type { Dict } from "@/lib/i18n-constants";

/**
 * The demo island's copy. Kept out of chase-demo.tsx because that file is a client module: the page builds the labels
 * on the server and hands the island only the strings it prints.
 */
const L = [
  "pad.label", "pad.format", "pad.batting", "pad.overs", "pad.wide", "pad.out", "pad.undo", "pad.lastNone", "pad.last",
  "mc.label", "mc.live", "mc.ov", "mc.need", "mc.won", "mc.thisOver",
  "table.label", "table.group", "table.p", "table.w", "table.pts",
  "stream.labelSport", "stream.labelStreaming", "stream.channel", "stream.target", "stream.need",
  "stream.style", "stream.bar", "stream.bug", "stream.state", "stream.soon", "stream.live", "stream.recon", "stream.final",
] as const;
/** The stream tile's moments, worded by the REAL overlay's own dictionary (`public`), so the demo says what the stream says. */
const MOMENTS = {
  "moment.six": "overlay.moment.six",
  "moment.four": "overlay.moment.four",
  "moment.out": "overlay.moment.out",
  "moment.endOfOver": "overlay.endOfOver.title",
  "moment.runsScore": "overlay.endOfOver.runsScore",
} as const;
export type ChaseDemoLabels = Record<(typeof L)[number] | keyof typeof MOMENTS, string>;

export function chaseDemoLabels(dict: Dict, overlay: Dict): ChaseDemoLabels {
  return {
    ...Object.fromEntries(L.map((k) => [k, t(dict, `product.demo.${k}` as never)])),
    ...Object.fromEntries(Object.entries(MOMENTS).map(([k, key]) => [k, t(overlay, key as never)])),
  } as ChaseDemoLabels;
}
