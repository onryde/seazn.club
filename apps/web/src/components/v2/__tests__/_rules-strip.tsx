// Match Day C2 — the division's match rules, standings points and online play moved out of Settings into the Division rules
// strip on the Fixtures tab (`rules/division-rules-strip.tsx`). The suites written against Settings' Match rules block drive
// the strip instead, through this one adapter: the same division shape in, the strip's props out, and a tree walk that opens
// the strip's child editors (Match format, Points, Tie-breaks) the way a browser renders them, so a test still finds the
// `<MatchRuleFields>` grid and the points boxes it used to find inline.
import { isValidElement, type ReactElement, type ReactNode } from "react";
import { expandWithHooks, walk } from "@/components/__tests__/_hook-harness";
import { DivisionRulesStrip, type DivisionRulesStripProps, type RulesPanel } from "@/components/v2/rules/division-rules-strip";
import { MatchFormatEditor } from "@/components/v2/rules/match-format-editor";
import { PointsEditor } from "@/components/v2/rules/points-editor";
import { TiebreaksEditor } from "@/components/v2/rules/tiebreaks-editor";
import type { RefusedField } from "@/lib/rule-errors";
import type { LinkGapsSummary } from "@/lib/online-link-gaps";

export { DivisionRulesStrip };

/** Every panel open: the suites read the format, points and tie-break controls without a toggle click first. */
export const ALL_PANELS: readonly RulesPanel[] = ["format", "points", "tiebreaks"];

/** The division a Settings suite describes, as the strip takes it. */
export interface DivisionShape {
  division: { id: string; sport_key: string; variant_key: string | null; config: Record<string, unknown>; tiebreakers?: readonly string[] | null };
  variants?: readonly { key: string; name: string; system?: boolean; config?: Record<string, unknown> }[];
  lockedFields?: readonly RefusedField[];
  canEdit?: boolean;
  onlineChessOffered?: boolean;
  lichessGaps?: LinkGapsSummary;
}

export function stripPropsOf(p: DivisionShape, over: Partial<DivisionRulesStripProps> = {}): DivisionRulesStripProps {
  return {
    divisionId: p.division.id,
    sportKey: p.division.sport_key,
    variantKey: p.division.variant_key,
    divisionConfig: p.division.config,
    divisionTiebreakers: (p.division.tiebreakers ?? null) as DivisionRulesStripProps["divisionTiebreakers"],
    tableKinds: ["league"],
    canEdit: p.canEdit ?? true,
    variants: p.variants ?? [],
    lockedFields: p.lockedFields ?? [],
    onlineChessOffered: p.onlineChessOffered ?? true,
    lichessGaps: p.lichessGaps,
    initialOpen: ALL_PANELS,
    ...over,
  };
}

/**
 * The strip's tree, with its Match format, Points and (division) Tie-breaks editors opened one level (each is a
 * read-only-hooks presentational child: `useMsg` only). A test finds `<MatchRuleFields>` (division format, edit), the points
 * `<input>`s and each panel's Save exactly as the browser renders them, and their handlers are the strip's own setters.
 */
export function expandRules(node: ReactNode): ReactElement[] {
  const out: ReactElement[] = [];
  for (const el of walk(node)) {
    out.push(el);
    const division = (el.props as { scope?: unknown }).scope === "division";
    if (el.type !== MatchFormatEditor && !((el.type === PointsEditor || el.type === TiebreaksEditor) && division)) continue;
    let inner = expandWithHooks(el.type as (props: unknown) => ReactNode, el.props);
    // Points and Tie-breaks dispatch to their scope's own component: open that one too.
    if (el.type !== MatchFormatEditor && isValidElement(inner) && typeof inner.type === "function")
      inner = expandWithHooks(inner.type as (props: unknown) => ReactNode, inner.props);
    out.push(...expandRules(inner));
  }
  return out;
}
