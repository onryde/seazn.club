/**
 * The sports that have a product page at /sports/{sport}, by URL slug. Wave order, not alphabetical: later waves
 * APPEND and never reorder (a concurrent branch inserting into a sorted list is the ugliest merge there is). Any other
 * slug is a 404.
 */
export const SPORT_PAGES = ["cricket", "badminton", "table-tennis", "volleyball"] as const;
export type SportPageKey = (typeof SPORT_PAGES)[number];

export function isSportPage(s: string): s is SportPageKey {
  return (SPORT_PAGES as readonly string[]).includes(s);
}

/** The sport's key in the engine and in the dictionaries (`sport.{key}.*`): the slug without its hyphen. */
export function sportKeyOf(slug: SportPageKey): string {
  return slug.replace(/-/g, "");
}

/**
 * Who plays the rally sports' demo match, and the two other names in its group table. Racquet sports are people,
 * volleyball is teams; the names are the ones on Seazn Demo Club's own pages, so the demo and the pictures agree.
 */
export const RALLY_SIDES = {
  badminton: { a: "Priya Nair", b: "Elin Shah", others: ["Rosa Lindqvist", "Maya Okafor"] },
  tabletennis: { a: "Tom Achebe", b: "Dev Menon", others: ["Luca Brandt", "Sam Whitlock"] },
  volleyball: { a: "Southend Spikers", b: "Hadleigh Hawks", others: ["Canvey Crushers", "Leigh Lions"] },
} as const;
