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
//   - knockoutAllowed: C23's own premise, decided by the engine (owner ruling 2026-11-07): a knockout is offered only
//     when no match of it can end level, because a level knockout result waits for an organiser's settle and a guest
//     has no organiser. Asked of the cfg a quick match knockout actually plays (`quickMatchKnockoutCfg`: the variant
//     under the knockout stage's preset deciders, as `createStages` stores them) through `bracketMayEndLevel`
//     (`knockoutMayEndLevel`). The probe's C23 check asks the same `knockoutMayEndLevel` of every real knockout fixture
//     it creates, so the offer's composed answer is proven against the fold the match plays. The presets are why
//     football, hockey and ice hockey are offered a knockout (extra time and penalties, a shoot-out, overtime decide a
//     level match). The earlier rule's `supportsDraws(cfg, "knockout")` was false for every variant, and its
//     tie / no-result clause (D10) refused only cricket, which the probe excludes by name.
import offerJson from "@/lib/quick-match-offer.generated.json";
import { isChessSport } from "@/lib/chess-individual-only";
import { sql } from "@/lib/db";
import { messages, type MessageKey } from "@/lib/messages";
import { variantWordKey } from "@/lib/variant-label-keys";
import { resolveModule } from "@/server/engine-db/registry";
import { resolveFixtureCfg } from "@/server/engine-db/fixture-cfg";
import { bracketMayEndLevel, type AnySportModule, type EntrantKind } from "@seazn/engine/sport";
import { entrantShapeOf } from "./entrant-shape";
import { quickMatchStageInput } from "./quick-match-preview";
import { withStageDefaults } from "./stage-defaults";

/** The probe's output, as committed: the refusal's CODE only, never the engine's message (B6f), and no kind per entry
 *  (the kind is a per-sport axis `offerFor` computes, D2). An offered entry records the `knockoutAllowed` the probe saw,
 *  so the drift pin reds when the engine's declaration moves (review M2); `offerFor` still computes it, never reads it. */
export interface QuickMatchOfferJson {
  engine: string;
  generatedAt: string;
  offered: { sport_key: string; variant_key: string; knockoutAllowed: boolean }[];
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

/**
 * The fold cfg of a quick match knockout's match, before any exists: the variant's config (what the division holds)
 * under the knockout stage's config as `createStages` stores it (`withStageDefaults`: the sport's preset deciders for a
 * knockout of this variant), resolved the way a fixture's fold is (`resolveFixtureCfg`: division ⊕ stage rules ⊕ the
 * bracket deciders, schema defaults filled). The probe checks this against every real knockout fixture it creates.
 */
export function quickMatchKnockoutCfg(mod: AnySportModule, variant_key: string, variantConfig: unknown): unknown {
  const stage = withStageDefaults(mod, "knockout", variant_key, quickMatchStageInput({ format: "knockout", plays: 1, name: "" }).config);
  return resolveFixtureCfg({ config_snapshot: null, rules_override: null }, variantConfig, { kind: "knockout", config: stage }, mod);
}

/** C23 (owner ruling 2026-11-07): can a knockout match under `cfg` end level, so that it would wait for an organiser's
 *  settle? The engine's one answer (`bracketMayEndLevel`), shared by `offerFor` and the probe. */
export function knockoutMayEndLevel(mod: AnySportModule, cfg: unknown): boolean {
  return bracketMayEndLevel(mod, "knockout", cfg);
}

/** One system variant's catalog facts: its row joined to its sport's pinned module version. */
interface SystemVariantRow {
  sport_key: string;
  variant_key: string;
  module_version: string;
  config: unknown;
}

/** The offer for one catalog row, in memory: the one place the three facts are computed, for `offerFor` (one row) and
 *  `listQuickMatchSports` (every row from one query). */
function offerOf({ sport_key, variant_key, module_version, config }: SystemVariantRow): QuickMatchOffer {
  const mod = resolveModule(sport_key, module_version);
  const kinds: EntrantKind[] = isChessSport(sport_key)
    ? ["individual"]
    : [...entrantShapeOf({ sport_key, module_version, config }).kinds];
  const knockoutAllowed = !knockoutMayEndLevel(mod, quickMatchKnockoutCfg(mod, variant_key, config));
  const offered = OFFER.offered.some((o) => o.sport_key === sport_key && o.variant_key === variant_key);
  return { offered, kinds, knockoutAllowed };
}

/** One sport × SYSTEM variant (an org's own preset is never offered to a guest). An unknown sport or variant offers
 *  nothing. `kinds` and `knockoutAllowed` are computed for every known variant, offered or not: the probe reads them
 *  while it is still producing `offered`. */
export async function offerFor(sport_key: string, variant_key: string): Promise<QuickMatchOffer> {
  const [row] = await sql<SystemVariantRow[]>`
    select v.sport_key, v.key as variant_key, s.module_version, v.config
    from sport_variants v join sports s on s.key = v.sport_key
    where v.sport_key = ${sport_key} and v.key = ${variant_key} and v.is_system and v.org_id is null`;
  return row ? offerOf(row) : nothing();
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
  // One query; the rest is in memory (review M8: it was two more per variant, through `offerFor`).
  const rows = await sql<SystemVariantRow[]>`
    select v.sport_key, v.key as variant_key, s.module_version, v.config
    from sport_variants v join sports s on s.key = v.sport_key
    where v.is_system and v.org_id is null
    order by v.sport_key, v.key`;
  const bySport = new Map<string, QuickMatchSport>();
  for (const row of rows) {
    const { sport_key, variant_key } = row;
    const offer = offerOf(row);
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
