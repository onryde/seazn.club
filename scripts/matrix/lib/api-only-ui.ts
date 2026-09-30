// D7 (plan; design §8's scopes), stated once: what the organiser has for an
// API-only row on a sport. Either no builder control builds it — the wave
// that owns one is named — or, on the two cells a catalog template reaches,
// only that template, which W1c does not drive (the gallery and team seeding
// are W1-driving's).
//
// A LEAF, on purpose (W1c Task 12): the browser driver prints this as its
// organiser-ui-path check, and the layer planner (lib/layers.ts, which run.ts
// loads statically and which must never reach lib/browser — boundary.test.ts)
// plans it as 🚫. Neither keeps a copy.
import { API_ONLY_ROWS, type ApiOnlyRowKey } from "./catalogue.ts";

/** The wave that owns the organiser control each API-only row lacks. */
export const API_ONLY_UI_WAVE: Readonly<Record<ApiOnlyRowKey, string>> = Object.freeze({
  knockout_third_place: "W4", page_playoff_only: "W4", stepladder_only: "W4", group_only: "W5", group_group_ko: "W5",
});
/** The two API-only cells a catalog template does reach (template-card-<key>). */
export const TEMPLATE_ONLY_CELLS: Readonly<Record<string, string>> = Object.freeze({ "group_only|badminton": "box-league", "group_group_ko|cricket": "t20-super8" });
export const TEMPLATE_DRIVING_WAVE = "W1-driving";

export interface ApiOnlyUiPath {
  /** Who owes the organiser path. */
  readonly wave: string;
  /** The catalog template that reaches the cell, or null: no organiser control at all. */
  readonly template: string | null;
  readonly reason: string;
}

/** A row that is not API-only has a builder control; asking this about it is a harness bug. */
export class NotApiOnlyRow extends Error {
  constructor(row: string) {
    super(`api-only-ui: '${row}' is not an API-only row (${API_ONLY_ROWS.join(", ")}) — the division builder builds it`);
    this.name = "NotApiOnlyRow";
  }
}

export function apiOnlyUiPath(row: ApiOnlyRowKey, sport: string): ApiOnlyUiPath {
  // Own keys only, and refused by name: under strip-types a template row would
  // otherwise read `undefined` as its wave.
  if (!Object.prototype.hasOwnProperty.call(API_ONLY_UI_WAVE, row)) throw new NotApiOnlyRow(row);
  const cell = `${row}|${sport}`;
  const template = Object.prototype.hasOwnProperty.call(TEMPLATE_ONLY_CELLS, cell) ? TEMPLATE_ONLY_CELLS[cell] : null;
  return template === null
    ? { wave: API_ONLY_UI_WAVE[row], template: null, reason: `no organiser control builds ${row}` }
    : { wave: TEMPLATE_DRIVING_WAVE, template, reason: `reachable only through catalog template ${template}; driving it` };
}
