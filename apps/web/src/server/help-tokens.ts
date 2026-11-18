// Plan figures in help Markdown: `{{plan:<feature_key>:<plan>}}` is replaced by
// the plan table's integer for that feature and plan (plan_entitlements, read
// through loadPricingMatrix), so a fee or a cap is never typed into a page.
//
// Pure: takes the already-loaded matrix. Loading it is async and needs a
// database, which `next build` does not have, so the caller decides when to load
// (see the freshness note in help-content.ts).
//
// RENDERING RULES
//  - int_value features only: the cell's integer, as written ("5", not "5%").
//    The Markdown keeps its own "%" or unit, so a sentence reads the same as it
//    did when the figure was typed.
//  - A boolean or null cell, an unknown feature or an unknown plan THROWS,
//    naming the token. Never an empty string, never the raw token: a help page
//    showing a hole where a price should be is worse than a failed render.
//  - Prices and currency amounts are not rendered by this token. There is no
//    single right rendering for them (currency, billing interval, tax), so a
//    price stays typed until a task decides that.
import type { MatrixData } from "@/lib/pricing-matrix";

const TOKEN_OPEN = "{{plan:";

/** `{{plan:feature.key:plan_key}}` — the feature key is dotted/snake, the plan is snake. */
const TOKEN_SOURCE = String.raw`\{\{plan:([A-Za-z0-9_.-]+):([A-Za-z0-9_]+)\}\}`;

/** True when the Markdown carries a plan token — or something that tries to be one. */
export function hasHelpTokens(markdown: string): boolean {
  return markdown.includes(TOKEN_OPEN);
}

export function resolveHelpTokens(markdown: string, matrix: MatrixData): string {
  const out = markdown.replace(new RegExp(TOKEN_SOURCE, "g"), (token, feature: string, plan: string) => {
    const cell = matrix[feature]?.[plan];
    if (!cell) {
      throw new Error(
        `help token ${token}: no plan_entitlements row for feature '${feature}' on plan '${plan}'`,
      );
    }
    if (cell.int_value === null || cell.int_value === undefined) {
      throw new Error(
        `help token ${token}: '${feature}' on plan '${plan}' has no integer value (boolean and null cells are not rendered)`,
      );
    }
    return String(cell.int_value);
  });
  // A token that is almost right ("{{plan:fee}}", a space inside) must not ship as raw text.
  const stray = out.indexOf(TOKEN_OPEN);
  if (stray !== -1) {
    throw new Error(`help token malformed near '${out.slice(stray, stray + 60)}': expected {{plan:<feature_key>:<plan>}}`);
  }
  return out;
}
