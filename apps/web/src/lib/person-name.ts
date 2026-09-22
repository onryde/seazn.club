// A player's `persons.full_name`, as the API bounds it.
//
// Dependency-free: server/api-v1/schemas.ts imports it by relative `.ts` path.

/** The longest `full_name` the API accepts. `CreatePerson` and `PatchPerson`
 *  (server/api-v1/schemas.ts) read it from here, and so does the directory's
 *  rename field, so the field cannot offer a name the PATCH refuses. */
export const PERSON_NAME_MAX = 200;
