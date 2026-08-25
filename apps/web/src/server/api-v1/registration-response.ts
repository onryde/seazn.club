import type { RegistrationWithGroupRow } from "@/server/usecases/registrations";

/**
 * The organiser-facing wire shape of one registration.
 *
 * `v1()` does NOT validate or strip against the OpenAPI response schema — it
 * serialises whatever the handler returns (`api-v1/http.ts:124-149`). So the
 * usecases' `RegistrationWithGroupRow`, which carries the cart's
 * `access_token_hash` because `regGroupCols` selects it for the token-compare
 * paths, shipped that hash to the client from every single-registration action
 * route. It is credential-derived — the hash the registrant's own
 * `?token=` is compared against — and has no reason to leave the server.
 *
 * One helper rather than a destructure per route: RS005 W1b shipped three
 * hand-written strips in three new routes before the six pre-existing siblings
 * were even counted, which is nine copies of a security-relevant line and the
 * exact drift class this session has been removing elsewhere. A new action
 * route that forgets to call this is a review catch; a new SECRET column is
 * caught here, once.
 */
export function organiserRegistration<T extends RegistrationWithGroupRow>(
  row: T,
): Omit<T, "access_token_hash"> {
  const { access_token_hash: _accessTokenHash, ...rest } = row;
  return rest;
}
