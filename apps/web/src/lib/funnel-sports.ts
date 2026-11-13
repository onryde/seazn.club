// The /start funnel's sports, in the order the wizard shows them (mock swr13a01 B1). `key` is what /play and the home
// hero send as `/start?sport=`; `name` is the sports catalogue's name (`sports.name`, written by scripts/sync-sports.ts),
// which is the `sport` value /api/funnel/start stores and the claim resolves (lib/funnel.ts `resolveSport`); `module` and
// `variant` are the engine sport and system variant that claim builds — Other names no sport, so it builds the generic
// module. The sports, their order, keys and names are lib/funnel-sport-keys.ts's (the import-free list the client doors
// read); this module adds what the claim builds for each key. Pure and client-safe. Every field is pinned against its
// authority (the catalogue writer, the engine registry, `pickVariant`) in lib/__tests__/funnel-formats.test.ts; the list
// and its entries are frozen, so a caller holding one cannot change the next lookup.
import { FUNNEL_SPORT_IDS, funnelSportKeyByKeyOrName, type FunnelSportKey } from "./funnel-sport-keys";
import { defaultMatchMinutes } from "./match-length";

export interface FunnelSport {
  readonly key: string;
  readonly name: string;
  readonly module: string;
  readonly variant: string;
}

/** The system variant the claim builds for each funnel sport, and its engine module where that is not the key. */
const BUILDS: Readonly<Record<FunnelSportKey, { readonly variant: string; readonly module?: string }>> = {
  badminton: { variant: "bwf-3x15" },
  boardgame: { variant: "blitz" },
  carrom: { variant: "club-29" },
  football: { variant: "11-a-side" },
  hockey: { variant: "fih-outdoor" },
  icehockey: { variant: "iihf" },
  tabletennis: { variant: "bo5" },
  tennis: { variant: "tour" },
  volleyball: { variant: "beach" },
  cricket: { variant: "t20" },
  other: { variant: "score", module: "generic" },
};

export const FUNNEL_SPORTS: readonly FunnelSport[] = Object.freeze(
  FUNNEL_SPORT_IDS.map(({ key, name }): FunnelSport => {
    const { variant, module = key } = BUILDS[key];
    return Object.freeze({ key, name, module, variant });
  }),
);

/** The funnel sport a link names, by key (`tabletennis`) or by name (`Table Tennis`), in any case; null for anything
 *  else. */
export function funnelSportByKeyOrName(raw: string): FunnelSport | null {
  const key = funnelSportKeyByKeyOrName(raw);
  return key === null ? null : (FUNNEL_SPORTS.find((s) => s.key === key) ?? null);
}

/** How long one match of `s` blocks a court, in minutes: the house's length for the variant the claim builds
 *  (lib/match-length.ts), the number the format cards time the day with. */
export function funnelSportMatchMinutes(s: FunnelSport): number {
  return defaultMatchMinutes(s.module, s.variant);
}
