/**
 * The sports that have a product page at /sports/{sport}, by URL slug. Wave order, not alphabetical: later waves
 * APPEND and never reorder (a concurrent branch inserting into a sorted list is the ugliest merge there is). Any other
 * slug is a 404.
 */
export const SPORT_PAGES = ["cricket", "badminton", "table-tennis", "volleyball", "football", "tennis", "hockey", "ice-hockey"] as const;
export type SportPageKey = (typeof SPORT_PAGES)[number];

export function isSportPage(s: string): s is SportPageKey {
  return (SPORT_PAGES as readonly string[]).includes(s);
}

/** The sport's key in the engine and in the dictionaries (`sport.{key}.*`): the slug without its hyphen. */
export function sportKeyOf(slug: SportPageKey): string {
  return slug.replace(/-/g, "");
}

/**
 * Who plays each sport's demo match, and the two other names in its group table. Racquet sports are people, the rest
 * are teams; the names are the ones on Seazn Demo Club's own pages, so the demo and the pictures agree.
 */
export const DEMO_SIDES = {
  badminton: { a: "Priya Nair", b: "Elin Shah", others: ["Rosa Lindqvist", "Maya Okafor"] },
  tabletennis: { a: "Tom Achebe", b: "Dev Menon", others: ["Luca Brandt", "Sam Whitlock"] },
  volleyball: { a: "Southend Spikers", b: "Hadleigh Hawks", others: ["Canvey Crushers", "Leigh Lions"] },
  football: { a: "Southend Blue Blazers", b: "Rayleigh Rovers", others: ["Thorpe Bay Tigers", "Leigh Lions"] },
  tennis: { a: "Priya Nair", b: "Tanvi Deshmukh", others: ["Rosa Lindqvist", "Maya Okafor"] },
  hockey: { a: "Southend Sticks", b: "Hadleigh Hawks", others: ["Canvey Comets", "Leigh Lions"] },
  icehockey: { a: "Southend Blades", b: "Hadleigh Hawks", others: ["Canvey Kings", "Leigh Lions"] },
} as const;
export type DemoSportKey = keyof typeof DEMO_SIDES;
