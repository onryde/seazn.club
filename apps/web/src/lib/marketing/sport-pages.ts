/**
 * The sports that have a product page at /sports/{sport}. Wave order, not alphabetical: later waves APPEND and never
 * reorder (a concurrent branch inserting into a sorted list is the ugliest merge there is). Any other slug is a 404.
 */
export const SPORT_PAGES = ["cricket"] as const;
export type SportPageKey = (typeof SPORT_PAGES)[number];

export function isSportPage(s: string): s is SportPageKey {
  return (SPORT_PAGES as readonly string[]).includes(s);
}
