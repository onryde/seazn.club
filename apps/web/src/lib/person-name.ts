// A player's `persons.full_name`, as the API bounds it.
//
// Dependency-free: server/api-v1/schemas.ts imports it by relative `.ts` path.

/** The longest `full_name` the API accepts. `CreatePerson` and `PatchPerson`
 *  (server/api-v1/schemas.ts) read it from here, and so does the directory's
 *  rename field, so the field cannot offer a name the PATCH refuses. */
export const PERSON_NAME_MAX = 200;

/** The name a typed New player is created with: the ends trimmed, the inside as typed. "" means nothing was typed. */
export function cleanPersonName(raw: string): string {
  return raw.trim();
}

/** The person Players already holds under a typed name (whole name, case-insensitive, ends trimmed on both sides),
 *  or null. The add form's New player selects this person instead of minting a duplicate. */
export function findPersonByName<P extends { full_name: string }>(persons: readonly P[], typed: string): P | null {
  const key = cleanPersonName(typed).toLowerCase();
  if (!key) return null;
  return persons.find((p) => cleanPersonName(p.full_name).toLowerCase() === key) ?? null;
}
