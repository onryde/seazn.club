// The /start funnel's sports by key and name, in the order the wizard shows them (mock swr13a01 B1): the one list of the
// sports /start takes. `key` is what /play and the home hero send as `/start?sport=`; `name` is the sports catalogue's
// name (`sports.name`, written by scripts/sync-sports.ts). lib/funnel-sports.ts builds FUNNEL_SPORTS from this list,
// adding the engine module and variant the claim builds for each key.
//
// It imports nothing (start wizard T5 review m3): the client doors that ask "does /start take this sport?" (the home
// hero's organiser link, /play's season link) read it here, so the marketing home's bundle carries no match-length table
// and no server/external-play. lib/__tests__/funnel-sport-keys.test.ts pins both facts. The list and its entries are
// frozen, so a caller holding one cannot change the next lookup.

const id = <K extends string>(key: K, name: string) => Object.freeze({ key, name });

export const FUNNEL_SPORT_IDS = Object.freeze([
  id("badminton", "Badminton"),
  id("boardgame", "Chess"),
  id("carrom", "Carrom"),
  id("football", "Football"),
  id("hockey", "Hockey"),
  id("icehockey", "Ice Hockey"),
  id("tabletennis", "Table Tennis"),
  id("tennis", "Tennis"),
  id("volleyball", "Volleyball"),
  id("cricket", "Cricket"),
  id("other", "Other"),
]);

export type FunnelSportKey = (typeof FUNNEL_SPORT_IDS)[number]["key"];

/** The funnel sport's key a link names, by key (`tabletennis`) or by name (`Table Tennis`), in any case; null for
 *  anything else. */
export function funnelSportKeyByKeyOrName(raw: string): FunnelSportKey | null {
  if (typeof raw !== "string") return null;
  const wanted = raw.trim().toLowerCase();
  if (wanted === "") return null;
  return FUNNEL_SPORT_IDS.find((s) => s.key === wanted || s.name.toLowerCase() === wanted)?.key ?? null;
}
