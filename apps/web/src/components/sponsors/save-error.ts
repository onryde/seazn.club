// The Sponsors hub's refusal copy (final review D3): ONE map from the v1 envelope's machine code to a dictionary key, for the
// On stream tab's tick and dial and Share report's create and revoke. The server's sentence is English and names internals
// ("competition not found"), so it is never shown; a code this map does not know reads the house fallback. Pure: no hooks, no
// "use client", like break-labels.ts beside it.
import { ApiV1Error } from "@/lib/client-v1";
import type { MessageKey } from "@/lib/messages";

/** The codes the hub's routes refuse with (`statusCode` in server/api-v1/http.ts), each to its own words. */
export const SAVE_ERROR_MSG: Readonly<Record<string, MessageKey>> = {
  VALIDATION: "sponsors.error.invalid",
  UNAUTHENTICATED: "sponsors.error.signedOut",
  FORBIDDEN: "sponsors.error.forbidden",
  NOT_FOUND: "sponsors.error.notFound",
  RATE_LIMITED: "sponsors.error.rateLimited",
};

/** Anything else: another code, a network failure, a body that was not the envelope. */
export const SAVE_ERROR_FALLBACK_MSG: MessageKey = "settings.saveFailed";

/** The key a failed hub write shows. An inherited name (`toString`) is not a code. */
export function sponsorSaveErrorKey(err: unknown): MessageKey {
  return err instanceof ApiV1Error && Object.hasOwn(SAVE_ERROR_MSG, err.code) ? SAVE_ERROR_MSG[err.code]! : SAVE_ERROR_FALLBACK_MSG;
}
