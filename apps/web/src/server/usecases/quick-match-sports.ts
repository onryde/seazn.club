import "server-only";
// Quick match (spec docs/superpowers/specs/2026-11-03-quick-match-design.md §5, §9, §13; plan 1 Task 6): what a guest
// may create. The ONE source of these facts (pre-flight A9): the create's guards (`createQuickMatch`), the setup
// screen's list (`listQuickMatchSports`) and the probe that proves the offer all ask `offerFor`.
//
// Three facts per sport × system variant, each from its own authority:
//   - offered: the probe scored a complete match of it with no lineup, through the real write path
//     (`__tests__/_quick-match-probe.ts`, which writes `lib/quick-match-offer.generated.json`). Never typed here.
//   - kinds: the sport's own entrant model (pre-flight D2: Singles/Doubles is the entrant kind, a per-sport axis, not a
//     variant), read from the catalog rows before any division exists; chess is individual only (owner, 2026-10-26).
//   - knockoutAllowed: the engine's own declaration (C23 with D10): a knockout is offered only when the variant cannot
//     end level in a bracket (`supportsDraws(cfg, "knockout")` false) AND its table can pay neither a tie nor a no
//     result, because a level knockout result waits for an organiser's settle and a guest has no organiser. On engine
//     3.0.2 the `supportsDraws` clause is false for every variant, so the tie / no-result clauses are what refuse; the
//     stage's own preset deciders (extra time and penalties, a shoot-out, overtime) are what keep a football, hockey or
//     ice-hockey knockout from ending level, and the probe asserts that of every knockout it creates
//     (`bracketMayEndLevel` over the seated match's own fold cfg).
import offerJson from "@/lib/quick-match-offer.generated.json";
import { isChessSport } from "@/lib/chess-individual-only";
import { sql } from "@/lib/db";
import { messages, type MessageKey } from "@/lib/messages";
import { variantWordKey } from "@/lib/variant-label-keys";
import { resolveModule } from "@/server/engine-db/registry";
import { withSchemaDefaults } from "@/server/engine-db/fixture-cfg";
import type { EntrantKind } from "@seazn/engine/sport";
import { entrantShapeOf } from "./entrant-shape";

/** The probe's output, as committed: the refusal's CODE only, never the engine's message (B6f), and no kind per entry
 *  (the kind is a per-sport axis `offerFor` computes, D2). */
export interface QuickMatchOfferJson {
  engine: string;
  generatedAt: string;
  offered: { sport_key: string; variant_key: string }[];
  excluded: { sport_key: string; variant_key: string; code: string }[];
}

const OFFER = offerJson as QuickMatchOfferJson;

export interface QuickMatchOffer {
  offered: boolean;
  kinds: EntrantKind[];
  knockoutAllowed: boolean;
}

/** A fresh object per answer: a caller may mutate what it is given. */
const nothing = (): QuickMatchOffer => ({ offered: false, kinds: [], knockoutAllowed: false });

/** One sport × SYSTEM variant (an org's own preset is never offered to a guest). An unknown sport or variant offers
 *  nothing. `kinds` and `knockoutAllowed` are computed for every known variant, offered or not: the probe reads them
 *  while it is still producing `offered`. */
export async function offerFor(sport_key: string, variant_key: string): Promise<QuickMatchOffer> {
  const [sport] = await sql<{ module_version: string }[]>`select module_version from sports where key = ${sport_key}`;
  if (!sport) return nothing();
  const [variant] = await sql<{ config: unknown }[]>`
    select config from sport_variants
    where sport_key = ${sport_key} and key = ${variant_key} and is_system and org_id is null`;
  if (!variant) return nothing();

  const mod = resolveModule(sport_key, sport.module_version);
  const kinds: EntrantKind[] = isChessSport(sport_key)
    ? ["individual"]
    : [...entrantShapeOf({ sport_key, module_version: sport.module_version, config: variant.config }).kinds];
  const cfg = withSchemaDefaults(mod, variant.config) as never;
  const level = mod.reachableResultKinds(cfg, "league");
  const knockoutAllowed = !mod.supportsDraws(cfg, "knockout") && !level.has("tie") && !level.has("noResult");
  const offered = OFFER.offered.some((o) => o.sport_key === sport_key && o.variant_key === variant_key);
  return { offered, kinds, knockoutAllowed };
}

export interface QuickMatchVariant {
  variant_key: string;
  labelKey: MessageKey;
  knockoutAllowed: boolean;
}
export interface QuickMatchSport {
  sport_key: string;
  labelKey: MessageKey;
  kinds: EntrantKind[];
  variants: QuickMatchVariant[];
}

const isMessageKey = (k: string): k is MessageKey => Object.hasOwn(messages, k);

/** The setup screen's sports: every system variant `offerFor` offers, grouped by sport in catalog key order. Names are
 *  dictionary keys, never the catalog's English `name` columns, so the screen renders them in all four locales (C1);
 *  a sport or variant the dictionary cannot name is not listed. `kinds` is the sport's own, one list per sport (D2). */
export async function listQuickMatchSports(): Promise<QuickMatchSport[]> {
  const rows = await sql<{ sport_key: string; variant_key: string }[]>`
    select v.sport_key, v.key as variant_key
    from sport_variants v join sports s on s.key = v.sport_key
    where v.is_system and v.org_id is null
    order by v.sport_key, v.key`;
  const bySport = new Map<string, QuickMatchSport>();
  for (const { sport_key, variant_key } of rows) {
    const offer = await offerFor(sport_key, variant_key);
    if (!offer.offered) continue;
    const sportLabel = `sport.${sport_key}`;
    const variantLabel = variantWordKey(sport_key, variant_key);
    if (!isMessageKey(sportLabel) || variantLabel === undefined) continue;
    let sport = bySport.get(sport_key);
    if (!sport) {
      sport = { sport_key, labelKey: sportLabel, kinds: offer.kinds, variants: [] };
      bySport.set(sport_key, sport);
    }
    sport.variants.push({ variant_key, labelKey: variantLabel, knockoutAllowed: offer.knockoutAllowed });
  }
  return [...bySport.values()];
}
