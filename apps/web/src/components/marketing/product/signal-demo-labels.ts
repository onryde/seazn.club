import { t } from "@/lib/i18n-runtime";
import type { Dict } from "@/lib/i18n-constants";

/** The signal demo's copy, built on the server: signal-demo.tsx is a client module and gets only the strings it prints. */
const PAD = ["pad.format", "pad.batting", "pad.overs", "pad.wide", "pad.out", "pad.undo", "pad.lastNone", "pad.last", "mc.live", "mc.ov", "mc.need", "mc.won"] as const;
const SIGNAL = ["label.phone", "label.others", "switch", "on", "off", "online", "queued", "sent", "upToDate", "behind"] as const;
export type SignalDemoLabels = Record<(typeof PAD)[number] | (typeof SIGNAL)[number], string>;

export function signalDemoLabels(dict: Dict): SignalDemoLabels {
  return Object.fromEntries([
    ...PAD.map((k) => [k, t(dict, `product.demo.${k}` as never)]),
    ...SIGNAL.map((k) => [k, t(dict, `product.signal.${k}` as never)]),
  ]) as SignalDemoLabels;
}
