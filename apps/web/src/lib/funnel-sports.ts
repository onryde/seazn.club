// The /start funnel's sports, in the order the wizard shows them (mock swr13a01 B1). `key` is what /play and the home
// hero send as `/start?sport=`; `name` is the sports catalogue's name (`sports.name`, written by scripts/sync-sports.ts),
// which is the `sport` value /api/funnel/start stores and the claim resolves (lib/funnel.ts `resolveSport`); `module` and
// `variant` are the engine sport and system variant that claim builds — Other names no sport, so it builds the generic
// module. Pure and client-safe. Every field is pinned against its authority (the catalogue writer, the engine registry,
// `pickVariant`) in lib/__tests__/funnel-formats.test.ts; the list and its entries are frozen, so a caller holding one
// cannot change the next lookup.
import { defaultMatchMinutes } from "./match-length";

export interface FunnelSport {
  readonly key: string;
  readonly name: string;
  readonly module: string;
  readonly variant: string;
}

const sport = (key: string, name: string, variant: string, module: string = key): FunnelSport =>
  Object.freeze({ key, name, module, variant });

export const FUNNEL_SPORTS: readonly FunnelSport[] = Object.freeze([
  sport("badminton", "Badminton", "bwf-3x15"),
  sport("boardgame", "Chess", "blitz"),
  sport("carrom", "Carrom", "club-29"),
  sport("football", "Football", "11-a-side"),
  sport("hockey", "Hockey", "fih-outdoor"),
  sport("icehockey", "Ice Hockey", "iihf"),
  sport("tabletennis", "Table Tennis", "bo5"),
  sport("tennis", "Tennis", "tour"),
  sport("volleyball", "Volleyball", "beach"),
  sport("cricket", "Cricket", "t20"),
  sport("other", "Other", "score", "generic"),
]);

/** The funnel sport a link names, by key (`tabletennis`) or by name (`Table Tennis`), in any case; null for anything
 *  else. */
export function funnelSportByKeyOrName(raw: string): FunnelSport | null {
  if (typeof raw !== "string") return null;
  const wanted = raw.trim().toLowerCase();
  if (wanted === "") return null;
  return FUNNEL_SPORTS.find((s) => s.key === wanted || s.name.toLowerCase() === wanted) ?? null;
}

/** How long one match of `s` blocks a court, in minutes: the house's length for the variant the claim builds
 *  (lib/match-length.ts), the number the format cards time the day with. */
export function funnelSportMatchMinutes(s: FunnelSport): number {
  return defaultMatchMinutes(s.module, s.variant);
}
