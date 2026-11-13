// The /start funnel's sports, in the order the wizard shows them (mock swr13a01 B1). `key` is the engine's sport key —
// what /play and the home hero send as `/start?sport=` — and `name` is the sports catalogue's name (`sports.name`,
// written by scripts/sync-sports.ts), which is the `sport` value /api/funnel/start stores and the claim resolves.
// Other names no sport: the claim builds it on the generic module. Pure and client-safe; the names are pinned against the
// catalogue's real writer in lib/__tests__/funnel-formats.test.ts.

export interface FunnelSport {
  key: string;
  name: string;
}

export const FUNNEL_SPORTS: readonly FunnelSport[] = [
  { key: "badminton", name: "Badminton" },
  { key: "boardgame", name: "Chess" },
  { key: "carrom", name: "Carrom" },
  { key: "football", name: "Football" },
  { key: "hockey", name: "Hockey" },
  { key: "icehockey", name: "Ice Hockey" },
  { key: "tabletennis", name: "Table Tennis" },
  { key: "tennis", name: "Tennis" },
  { key: "volleyball", name: "Volleyball" },
  { key: "cricket", name: "Cricket" },
  { key: "other", name: "Other" },
];

/** The funnel sport a link names, by key (`tabletennis`) or by name (`Table Tennis`), in any case; null for anything
 *  else. */
export function funnelSportByKeyOrName(raw: string): FunnelSport | null {
  if (typeof raw !== "string") return null;
  const wanted = raw.trim().toLowerCase();
  if (wanted === "") return null;
  return FUNNEL_SPORTS.find((s) => s.key === wanted || s.name.toLowerCase() === wanted) ?? null;
}
