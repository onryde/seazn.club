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
import { ONLINE_SIZES, includedRounds, packagePrice } from "@/lib/online-chess-package";
import type { MatrixData } from "@/lib/pricing-matrix";

const TOKEN_OPEN = "{{plan:";

/** `{{plan:feature.key:plan_key}}` — the feature key is dotted/snake, the plan is snake. */
const TOKEN_SOURCE = String.raw`\{\{plan:([A-Za-z0-9_.-]+):([A-Za-z0-9_]+)\}\}`;

/** True when the Markdown carries a plan token — or something that tries to be one. */
export function hasHelpTokens(markdown: string): boolean {
  return markdown.includes(TOKEN_OPEN);
}

/** Every well-formed plan token in the Markdown, in order (a repeated token is listed each time). */
export function helpTokensIn(markdown: string): { token: string; feature: string; plan: string }[] {
  return [...markdown.matchAll(new RegExp(TOKEN_SOURCE, "g"))].map((m) => ({ token: m[0], feature: m[1]!, plan: m[2]! }));
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

/**
 * Text with every plan token removed — for a surface that cannot load the plan table and must not
 * show a raw `{{plan:…}}` (the search index without a matrix). The figure is dropped, not invented;
 * a near-miss (`{{plan:fee}}`, a space inside) is dropped the same way.
 */
export function stripHelpTokens(text: string): string {
  return text.replace(/\{\{plan:[^}]*\}\}/g, "").replace(/ {2,}/g, " ").trim();
}

// ---------------------------------------------------------------------------------------------------------------------
// Online Chess figures: `{{online:...}}` (spec 2026-11-23-online-chess-credits-design.md §15; plan Task 13 carry (3)).
//
// The sizes, their prices and the Swiss rounds each includes are the price leaf's (lib/online-chess-package.ts: import-free, no
// database), so unlike a plan token these need no plan table and resolve wherever help is rendered, prerendered pages included.
//
//   {{online:largest}} / {{online:smallest}}                the ends of the ladder (players)
//   {{online:row:<i>:<field>}}   i = 1..ONLINE_SIZES.length, counted from 1 as the help table prints its rows;
//                                field = size | price (credits) | cameras (credits with the Fair-play camera) | rounds (Swiss rounds included)
//
// A token that is not exactly one of those THROWS, naming it (a hole where a price belongs is worse than a failed render), and so
// does a leftover `{{online:` after resolving: a near miss never ships as raw text. The row index, not the size, is the argument, so a
// table written with these tokens types no figure at all; a test pins that the table has one row per size of the ladder.
// ---------------------------------------------------------------------------------------------------------------------
const ONLINE_TOKEN = /\{\{online:([a-z0-9:]+)\}\}/g;
const ONLINE_FIELDS = ["size", "price", "cameras", "rounds"] as const;

function onlineFigure(name: string): number | null {
  if (name === "largest") return ONLINE_SIZES[ONLINE_SIZES.length - 1]!;
  if (name === "smallest") return ONLINE_SIZES[0]!;
  const m = /^row:([0-9]+):([a-z]+)$/.exec(name);
  if (!m) return null;
  const size = ONLINE_SIZES[Number(m[1]) - 1];
  if (size === undefined) return null;
  switch (m[2] as (typeof ONLINE_FIELDS)[number]) {
    case "size": return size;
    case "price": return packagePrice(size, false);
    case "cameras": return packagePrice(size, true);
    case "rounds": return includedRounds(size);
    default: return null;
  }
}

/** Every `{{online:...}}` token in the Markdown rendered from the price leaf; a near miss throws naming it. */
export function resolveOnlineTokens(markdown: string): string {
  const out = markdown.replace(ONLINE_TOKEN, (token, name: string) => {
    const figure = onlineFigure(name);
    if (figure === null) {
      throw new Error(
        `help token ${token}: not an Online Chess figure (expected {{online:largest}}, {{online:smallest}} or {{online:row:<1-${ONLINE_SIZES.length}>:<${ONLINE_FIELDS.join("|")}>}})`,
      );
    }
    return String(figure);
  });
  // Anything still looking like a token is a near miss and must not ship as raw text: a missing brace (`{{online:row:1:size}`), a
  // space or a capital (`{{ online:...}}`, `{{Online:...}}`), an empty name.
  const stray = /\{\{\s*online\s*:/i.exec(out);
  if (stray) {
    throw new Error(`help token malformed near '${out.slice(stray.index, stray.index + 60)}': expected an Online Chess token such as {{online:row:1:price}}`);
  }
  return out;
}
