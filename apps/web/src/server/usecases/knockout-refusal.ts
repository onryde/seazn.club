import "server-only";
// W4 app-A: the one way the server raises a knockout refusal. The status, the code and the English sentence come from
// the client-safe table (`lib/knockout-refusals.ts`), so a throw site names only the code; `details` rides on the error
// body as machine-readable hints, the way HttpError's `extra` does everywhere else (`api-v1/http.ts` merges it into the
// envelope). The `swissRefusal` pattern (swiss-refusal.ts).
import { HttpError } from "@/lib/errors";
import { KNOCKOUT_REFUSALS, type KnockoutRefusalCode } from "@/lib/knockout-refusals";

export function knockoutRefusal(code: KnockoutRefusalCode, details?: Record<string, unknown>): HttpError {
  const { status, en } = KNOCKOUT_REFUSALS[code];
  return new HttpError(status, en, code, details);
}
