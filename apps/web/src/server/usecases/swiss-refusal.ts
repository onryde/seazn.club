import "server-only";
// W3 Swiss app-A: the one way the server raises a Swiss refusal. The status, the code and the English sentence come
// from the client-safe table (`lib/swiss-refusals.ts`), so a throw site names only the code; `details` rides on the
// error body as machine-readable hints (e.g. `{ canAddRound }` for the desk's recovery button), the way HttpError's
// `extra` does everywhere else (`api-v1/http.ts` merges it into the envelope).
import { HttpError } from "@/lib/errors";
import { SWISS_REFUSALS, type SwissRefusalCode } from "@/lib/swiss-refusals";

export function swissRefusal(
  code: SwissRefusalCode,
  details?: Record<string, unknown>,
  /** W3 T11: `resolvable` raises the row's `resolvableStatus` (a 409) — only for a code that declares one. */
  opts?: { resolvable?: boolean },
): HttpError {
  const { status, resolvableStatus, message } = SWISS_REFUSALS[code];
  const chosen = opts?.resolvable === true ? resolvableStatus : status;
  if (chosen === undefined) throw new Error(`swiss refusal ${code} declares no resolvable status`);
  return new HttpError(chosen, message, code, details);
}
