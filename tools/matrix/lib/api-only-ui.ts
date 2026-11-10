// D7 (plan; design §8's scopes), stated once: what the organiser has for an
// API-only row on a sport. Either no builder control builds it — the wave
// that owns one is named — or, on the two cells a catalog template reaches,
// that template's gallery card does (ruling 47; W1-driving Task 13 drives
// them, so no wave owes them — lib/templates.ts).
//
// A LEAF, on purpose (W1c Task 12): the browser driver prints this as its
// organiser-ui-path check, and the layer planner (lib/layers.ts, which run.ts
// loads statically and which must never reach lib/browser — boundary.test.ts)
// plans it as 🚫. Neither keeps a copy.
import { API_ONLY_ROWS, type ApiOnlyRowKey } from "./catalogue.ts";
import { routeTo, type Route } from "./routing.ts";
import { templateFor } from "./templates.ts";

/** The route to the wave that owns the organiser control each API-only row lacks. A row the PRODUCT refuses on every
 *  sport has none: `page_playoff_only` and `stepladder_only` are refused standalone (W4 T16; RB4-S6, ruling 269 —
 *  catalogue.ts refusedCell, STANDALONE_REFUSED_REASON), so no wave owes them a control and no layer plans them. */
export const API_ONLY_UI_WAVE: Readonly<Partial<Record<ApiOnlyRowKey, Route>>> = Object.freeze({
  knockout_third_place: routeTo("W4", "no builder control for a third-place match (design §8)"),
  group_only: routeTo("W5", "no builder control for a group stage with no knockout (design §8)"),
  group_group_ko: routeTo("W5", "no builder control for two group stages (design §8)"),
});
/** No organiser control builds the cell: `wave` owes one. */
export interface NoUiPath { readonly reachable: false; readonly wave: string; readonly template: null; readonly reason: string }
/** A catalog template's gallery card builds the cell (ruling 47): no wave owes it. */
export interface TemplateUiPath { readonly reachable: true; readonly wave: null; readonly template: string; readonly reason: string }
export type ApiOnlyUiPath = NoUiPath | TemplateUiPath;

/** A row that is not API-only has a builder control; asking this about it is a harness bug. */
export class NotApiOnlyRow extends Error {
  constructor(row: string) {
    super(`api-only-ui: '${row}' is not an API-only row (${API_ONLY_ROWS.join(", ")}) — the division builder builds it`);
    this.name = "NotApiOnlyRow";
  }
}

/** An API-only row the product refuses (no route: API_ONLY_UI_WAVE) has no organiser path to judge and no wave owing
 *  one; a layer that reaches it planned a refused cell (catalogue.ts refusedCell), which is a harness bug. */
export class RefusedApiOnlyRow extends Error {
  constructor(row: string) {
    super(`api-only-ui: '${row}' is refused by the product (catalogue.ts refusedCell) — no wave owes it an organiser control, and no layer plans it`);
    this.name = "RefusedApiOnlyRow";
  }
}

/** The route of an API-only row the product offers. Own keys only, and refused by name: under strip-types a template
 *  row would otherwise read `undefined` as its wave, and so would a refused row. */
export function apiOnlyUiRoute(row: ApiOnlyRowKey): Route {
  const route = Object.prototype.hasOwnProperty.call(API_ONLY_UI_WAVE, row) ? API_ONLY_UI_WAVE[row] : undefined;
  if (route !== undefined) return route;
  if ((API_ONLY_ROWS as readonly string[]).includes(row)) throw new RefusedApiOnlyRow(row);
  throw new NotApiOnlyRow(row);
}

export function apiOnlyUiPath(row: ApiOnlyRowKey, sport: string): ApiOnlyUiPath {
  const route = apiOnlyUiRoute(row);
  const template = templateFor(row, sport);
  return template === null
    ? { reachable: false, wave: route.wave, template: null, reason: `no organiser control builds ${row}` }
    : { reachable: true, wave: null, template, reason: `built through catalog template ${template} (template-card-${template})` };
}
