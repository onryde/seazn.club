import type { RegistrationWithGroupRow } from "@/server/usecases/registrations";
import type { AuthCtx } from "@/server/api-v1/auth";
import { mayHoldBearerCredential } from "@/lib/types";

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
  auth: AuthCtx,
): Omit<T, "access_token_hash"> {
  const { access_token_hash: _accessTokenHash, ...rest } = row;
  // `join_code` is the OTHER credential on this row, and stripping it only on
  // the list surface left the nine action routes handing it straight back:
  // `regGroupCols` selects `r.join_code`, `v1()` strips nothing against the
  // response schema, and an API key (role: null) that the list route correctly
  // refuses could simply POST /confirm and read the code out of the reply.
  // POST /public/.../register/join then accepts that code with NO auth at all
  // and mints a roster row.
  //
  // Same predicate as the read model, imported rather than repeated — the rule
  // now lives in exactly one place for both surfaces.
  return mayHoldBearerCredential(auth.role) ? rest : { ...rest, join_code: null };
}
