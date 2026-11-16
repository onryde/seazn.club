import { t } from "@/lib/i18n-runtime";
import type { Dict } from "@/lib/i18n-constants";

/** The Match Day demo island's copy (`product.matchday.demo.*`), built on the server. */
const L = [
  "desk.label", "court", "vs",
  "state.free", "state.called", "state.playing",
  "act.call", "act.start", "act.result", "act.undo", "act.none",
  "next", "blocked", "waiting", "done", "reset",
  "phone.label", "phone.heading", "phone.free", "phone.called",
  "event.none", "event.call", "event.start", "event.result", "event.undo",
  "stream.label", "stream.live", "stream.waiting", "stream.none",
] as const;
export type MatchDayDemoLabels = Record<(typeof L)[number], string>;

export function matchDayDemoLabels(dict: Dict): MatchDayDemoLabels {
  return Object.fromEntries(L.map((k) => [k, t(dict, `product.matchday.demo.${k}` as never)])) as MatchDayDemoLabels;
}
