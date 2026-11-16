import { t } from "@/lib/i18n-runtime";
import type { Dict } from "@/lib/i18n-constants";

/** The scheduling demo's copy, built on the server so the client component ships no dictionary. */
const KEYS = [
  "board", "tray", "trayEmpty", "fill", "publish", "delay", "court", "free", "match", "place", "lift", "public", "notPublished", "updated",
  "status.start", "status.picked", "status.court", "status.team", "status.complete", "status.published", "status.delayed",
] as const;
export type DayBoardLabels = Record<(typeof KEYS)[number], string>;

/** The four demo sides. Proper names, the same in every language. */
export const DAY_TEAMS = ["Blazers", "Tigers", "Crusaders", "Lions"] as const;

export function dayBoardLabels(d: Dict): DayBoardLabels {
  return Object.fromEntries(KEYS.map((k) => [k, t(d, `product.scheduling.demo.${k}` as never)])) as DayBoardLabels;
}
