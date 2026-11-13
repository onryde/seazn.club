// What the setup page hands its island (quick match plan 2 Task 4, pre-flight B4b): names resolved on the server, and the
// copy the island reads. Pure, no `server-only` and no "use client": the page calls it on the server, and the island's
// test builds its props with the same two functions, so a key this file forgets reads as a raw key in an English
// assertion there.
import type { Dict } from "@/lib/i18n-constants";
import { QUICK_MATCH_ERRORS } from "@/lib/quick-match-constants";
import { t } from "@/lib/i18n-runtime";
import { pickVariant } from "@/lib/preferred-variant";
import type { QuickMatchSport } from "@/server/usecases/quick-match-sports";
import type { SetupSport } from "@/components/quick-match/setup-form";

/** The island's copy: the setup and error lines (marketing), and from ui the kind words. Flat `key → string`; nothing
 *  else of either dictionary. A league only (owner 2026-11-12), so no format word, draw card or round name ships. */
const MARKETING_PREFIXES = ["quickMatch.setup.", "quickMatch.errors."];
const UI_PREFIXES = [
  "quickMatch.kind.",
  // The kind switch's legend (screen readers only): "Who plays", the division builder's own word for the same choice.
  "divBuilder.step.who",
  // A refused bot check: #1136's shared sentence (reload, content blocker), as every guarded form shows it (review m2).
  "turnstile.error",
];

function pick(dict: Dict, prefixes: readonly string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(dict)) {
    if (typeof value === "string" && prefixes.some((p) => key.startsWith(p))) out[key] = value;
  }
  return out;
}

export function setupCopy(marketing: Dict, ui: Dict): Record<string, string> {
  return { ...pick(ui, UI_PREFIXES), ...pick(marketing, MARKETING_PREFIXES) };
}

/** The offer as the island takes it: every name in the page's language (C1, C14), the kinds labelled in the sport's own
 *  order (the first is the default, D6), the default rules by `pickVariant` (D6). A sport with no kind or no variant
 *  cannot be set up and is left out, so the island's non-empty types hold. Catalog order is kept (B4b). */
export function setupSports(sports: readonly QuickMatchSport[], ui: Dict): SetupSport[] {
  return sports.flatMap((s): SetupSport[] => {
    const [firstKind, ...moreKinds] = s.kinds.map((kind) => ({ kind, label: t(ui, `quickMatch.kind.${kind}`) }));
    const [firstVariant, ...moreVariants] = s.variants.map((v) => ({
      key: v.variant_key,
      name: t(ui, v.labelKey),
    }));
    if (!firstKind || !firstVariant) return [];
    const variants: SetupSport["variants"] = [firstVariant, ...moreVariants];
    return [
      {
        sport_key: s.sport_key,
        name: t(ui, s.labelKey),
        kinds: [firstKind, ...moreKinds],
        variants,
        defaultVariant: pickVariant(s.sport_key, variants),
      },
    ];
  });
}

const KNOWN_CODES: ReadonlySet<string> = new Set(Object.values(QUICK_MATCH_ERRORS));

/**
 * `?e=` as the island may take it: a code the create route sends, or null. The raw value never reaches the page's
 * payload (m1): a blank `?e=` is no refusal, and anything else that is not a known code is the generic failure. A
 * repeated `?e=` reads its first.
 */
export function refusalCode(e: string | string[] | undefined): string | null {
  const raw = (Array.isArray(e) ? e[0] : e)?.trim();
  if (!raw) return null;
  return KNOWN_CODES.has(raw) ? raw : QUICK_MATCH_ERRORS.CREATE_FAILED;
}
